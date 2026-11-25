[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_common.ps1")

if (Test-Path $script:StopFlag) {
    Remove-Item -Path $script:StopFlag -Force -ErrorAction SilentlyContinue
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\MediaVaultSupervisor", [ref]$createdNew)
if (-not $createdNew) {
    Write-MvLog "Another supervisor instance is already active; exiting." "WARN"
    exit 0
}

$script:KeepAliveProc = $null

function Ensure-WslKeepAlive {
    try {
        if ($null -eq $script:KeepAliveProc -or $script:KeepAliveProc.HasExited) {
            $script:KeepAliveProc = Start-Process -FilePath $script:WslExe `
                -ArgumentList @("-d", $script:WslDistro, "-u", "root", "--exec", "/bin/sleep", "infinity") `
                -WindowStyle Hidden -PassThru
        }
    } catch {
        Write-MvLog "WSL keepalive start skipped: $($_.Exception.Message)" "WARN"
    }
}

function Wait-WslAndDocker {
    for ($attempt = 1; $attempt -le 24; $attempt++) {
        $probe = Invoke-WslBash -Command 'systemctl is-active docker && systemctl is-active ssh && docker info >/dev/null 2>&1' -AsRoot
        if ($probe.ExitCode -eq 0) {
            return $true
        }
        $null = Invoke-WslBash -Command "systemctl start docker ssh || true" -AsRoot
        Start-Sleep -Seconds 5
    }
    return $false
}

function Wait-DrivesReady {
    $expected = @([System.IO.DriveInfo]::GetDrives() |
        Where-Object { $_.Name -match '^[CDE]:\\$' } |
        ForEach-Object { "/mnt/$($_.Name.Substring(0, 1).ToLowerInvariant())" })
    if ($expected.Count -eq 0) {
        return $true
    }
    $checks = ($expected | ForEach-Object { "test -d $_ && ls $_ >/dev/null 2>&1" }) -join " && "
    for ($attempt = 1; $attempt -le 18; $attempt++) {
        $probe = Invoke-WslBash -Command $checks
        if ($probe.ExitCode -eq 0) {
            return $true
        }
        Write-MvLog "Waiting for DrvFS mounts ($($expected -join ', ')) (attempt $attempt/18)..." "WARN"
        Start-Sleep -Seconds 5
    }
    return $false
}

function Start-ComposeStack {
    if (-not (Test-MvPreflight)) {
        return $false
    }
    $cmd = "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) up -d --remove-orphans"
    $res = Invoke-WslBash -Command $cmd
    if ($res.ExitCode -ne 0) {
        Write-MvLog "docker compose up failed (exit $($res.ExitCode)): $($res.Output)" "ERROR"
        return $false
    }
    Write-MvLog "Docker Compose stack synchronized cleanly."
    return $true
}

function Ensure-PortProxy {
    try {
        $existing = & netsh interface portproxy show v4tov4 2>&1 | Out-String
        foreach ($line in ($existing -split "\r?\n")) {
            if ($line -match '^\s*(\d+\.\d+\.\d+\.\d+)\s+8080\s+127\.0\.0\.1\s+8080\s*$') {
                & netsh interface portproxy delete v4tov4 listenport=8080 listenaddress=$($Matches[1]) | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "Unable to remove legacy HTTP portproxy." }
            }
        }
        $ipObj = Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -like "192.168.*" } |
            Select-Object -First 1
        $lan = if ($ipObj) { $ipObj.IPAddress } else { $null }
        if (-not $lan) {
            Write-MvLog "LAN IPv4 address not ready yet; skipping portproxy update." "WARN"
            return
        }
        $escapedLan = [regex]::Escape($lan)
        $existing = & netsh interface portproxy show v4tov4 2>&1 | Out-String
        if ($existing -notmatch "(?m)^\s*$escapedLan\s+443\s+127\.0\.0\.1\s+443\s*$") {
            if ($existing -match "(?m)^\s*$escapedLan\s+443\s+") {
                throw "LAN port 443 already has a different portproxy target."
            }
            & netsh interface portproxy add v4tov4 listenport=443 listenaddress=$lan connectport=443 connectaddress=127.0.0.1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Unable to register HTTPS portproxy." }
        }
        if ($existing -notmatch "(?m)^$escapedLan\s+22\s+127\.0\.0\.1\s+2222\b") {
            foreach ($line in ($existing -split "`r?`n")) {
                if ($line -match "^\s*(\d+\.\d+\.\d+\.\d+)\s+22\s+") {
                    & netsh interface portproxy delete v4tov4 listenport=22 listenaddress=$($Matches[1]) 2>$null | Out-Null
                }
            }
            & netsh interface portproxy add v4tov4 listenport=22 listenaddress=$lan connectport=2222 connectaddress=127.0.0.1 | Out-Null
        }
    } catch {
        Write-MvLog "portproxy refresh skipped: $($_.Exception.Message)" "WARN"
    }
}

function Test-MediaVaultReady {
    try {
        $resp = Get-MvInternalHealth -Endpoint ready
        return ($resp.ok -eq $true)
    } catch {
        return $false
    }
}

try {
    Write-MvLog "MediaVault supervisor starting (user=$env:USERNAME, distro=$($script:WslDistro))."
    if (-not (Wait-WslAndDocker)) {
        Write-MvLog "Docker or SSH systemd service did not become active in time." "ERROR"
        exit 1
    }
    Ensure-WslKeepAlive
    if (-not (Wait-DrivesReady)) {
        Write-MvLog "DrvFS mounts did not become ready in time; continuing because preflight is the authority." "ERROR"
    }
    Ensure-PortProxy
    $null = Start-ComposeStack

    $failures = 0
    $ticks = 0
    while (-not (Test-Path $script:StopFlag)) {
        Ensure-WslKeepAlive
        $ticks++
        if ($ticks % 4 -eq 0) {
            Ensure-PortProxy
        }
        if (Test-MediaVaultReady) {
            if ($failures -gt 0) {
                Write-MvLog "Health probe recovered (/health/ready = 200)."
            }
            $failures = 0
            Start-Sleep -Seconds 15
            continue
        }

        $failures++
        Write-MvLog "Health probe failed ($failures consecutive)." "WARN"
        if ($failures -ge 3) {
            Write-MvLog "Restarting unhealthy MediaVault services..." "WARN"
            $null = Wait-WslAndDocker
            $null = Wait-DrivesReady
            $null = Start-ComposeStack
            $null = Invoke-WslBash -Command "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) restart api nginx caddy || true"
            $backoff = [Math]::Min(120, 15 * $failures)
            Start-Sleep -Seconds $backoff
        } else {
            Start-Sleep -Seconds 15
        }
    }
    Write-MvLog "Stop flag detected; supervisor exiting gracefully."
    if ($script:KeepAliveProc -and -not $script:KeepAliveProc.HasExited) {
        Stop-Process -Id $script:KeepAliveProc.Id -Force -ErrorAction SilentlyContinue
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
