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

function Wait-WslAndDocker {
    for ($attempt = 1; $attempt -le 24; $attempt++) {
        $probe = Invoke-WslBash -Command "systemctl is-active docker && systemctl is-active ssh" -AsRoot
        if ($probe.ExitCode -eq 0) {
            return $true
        }
        $null = Invoke-WslBash -Command "systemctl start docker ssh || true" -AsRoot
        Start-Sleep -Seconds 5
    }
    return $false
}

function Wait-DrivesReady {
    for ($attempt = 1; $attempt -le 18; $attempt++) {
        $probe = Invoke-WslBash -Command "test -d /mnt/c -a -d /mnt/d -a -d /mnt/e && ls /mnt/e >/dev/null 2>&1"
        if ($probe.ExitCode -eq 0) {
            return $true
        }
        Write-MvLog "Waiting for /mnt/{c,d,e} DrvFS mounts (attempt $attempt/18)..." "WARN"
        Start-Sleep -Seconds 5
    }
    return $false
}

function Start-ComposeStack {
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
        $lan = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -like "192.168.*" } | Select-Object -First 1).IPAddress
        if (-not $lan) { $lan = "0.0.0.0" }
        $existing = & netsh interface portproxy show v4tov4 2>&1 | Out-String
        if ($existing -notmatch "8080\s+127\.0\.0\.1\s+8080") {
            & netsh interface portproxy delete v4tov4 listenport=8080 listenaddress=$lan 2>$null | Out-Null
            & netsh interface portproxy add v4tov4 listenport=8080 listenaddress=$lan connectport=8080 connectaddress=127.0.0.1 | Out-Null
        }
        if ($existing -notmatch "22\s+127\.0\.0\.1\s+2222") {
            & netsh interface portproxy delete v4tov4 listenport=22 listenaddress=$lan 2>$null | Out-Null
            & netsh interface portproxy add v4tov4 listenport=22 listenaddress=$lan connectport=2222 connectaddress=127.0.0.1 | Out-Null
        }
    } catch {
        Write-MvLog "portproxy refresh skipped: $($_.Exception.Message)" "WARN"
    }
}

function Test-MediaVaultReady {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8080/health/ready" -UseBasicParsing -TimeoutSec 6
        return ($resp.StatusCode -eq 200)
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
    $null = Wait-DrivesReady
    Ensure-PortProxy
    $null = Start-ComposeStack

    $failures = 0
    while (-not (Test-Path $script:StopFlag)) {
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
            $null = Invoke-WslBash -Command "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) restart nginx || true"
            $backoff = [Math]::Min(120, 15 * $failures)
            Start-Sleep -Seconds $backoff
        } else {
            Start-Sleep -Seconds 15
        }
    }
    Write-MvLog "Stop flag detected; supervisor exiting gracefully."
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
