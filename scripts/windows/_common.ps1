Set-StrictMode -Version Latest

$script:WslDistro = if ($env:MV_WSL_DISTRO) { $env:MV_WSL_DISTRO } else { "Ubuntu-24.04" }
$script:WslUser = if ($env:MV_WSL_USER) { $env:MV_WSL_USER } else { "giini" }
$script:RepoDir = if ($env:MV_REPO_DIR) { $env:MV_REPO_DIR } else { "/home/giini/Pmanager" }
$script:TaskName = "MediaVault-Supervisor"
$script:StateDir = "C:\ProgramData\MediaVault"
$script:BinDir = "C:\ProgramData\MediaVault\bin"
$script:LogDir = "C:\ProgramData\MediaVault\logs"
$script:LogFile = "C:\ProgramData\MediaVault\logs\supervisor.log"
$script:StopFlag = "C:\ProgramData\MediaVault\stop.flag"
$script:WslExe = if (Test-Path "C:\Program Files\WSL\wsl.exe") { "C:\Program Files\WSL\wsl.exe" } else { "C:\Windows\System32\wsl.exe" }
$script:ComposeArgs = @(
    "--env-file .env",
    "--env-file .env.asr",
    "--env-file .env.translation",
    "--env-file .env.embedding",
    "--env-file .env.scene",
    "-f compose.yaml",
    "-f compose.drives.yaml",
    "-f compose.asr.models.yaml",
    "-f compose.asr.cuda.yaml",
    "-f compose.translation.models.yaml",
    "-f compose.translation.cuda.yaml",
    "-f compose.embedding.models.yaml",
    "-f compose.embedding.cuda.yaml",
    "-f compose.gpu.yaml",
    "-f compose.scene.models.yaml",
    "-f compose.scene.cuda.yaml"
) -join " "

function Write-MvLog {
    param(
        [string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR")][string]$Level = "INFO"
    )
    if (-not (Test-Path $script:LogDir)) {
        New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
    }
    if ((Test-Path $script:LogFile) -and ((Get-Item $script:LogFile).Length -gt 10MB)) {
        for ($i = 4; $i -ge 1; $i--) {
            $src = "$($script:LogFile).$i"
            $dst = "$($script:LogFile).$($i + 1)"
            if (Test-Path $src) { Move-Item -Path $src -Destination $dst -Force }
        }
        Move-Item -Path $script:LogFile -Destination "$($script:LogFile).1" -Force
    }
    $stamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
    Add-Content -Path $script:LogFile -Value "$stamp [$Level] $Message" -Encoding UTF8
}

function Invoke-WslBash {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [switch]$AsRoot
    )
    $targetUser = if ($AsRoot) { "root" } else { $script:WslUser }
    $prevPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $script:WslExe -d $script:WslDistro -u $targetUser -- bash -lc $Command 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevPreference
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = ($output -join "`n")
    }
}

function Test-MvPreflight {
    $cmd = "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) run --rm --no-deps --build api bun run scripts/preflight.ts --require-all --min-free-mb 1024"
    $res = Invoke-WslBash -Command $cmd
    if ($res.ExitCode -ne 0) {
        Write-MvLog "Preflight failed (exit $($res.ExitCode)): $($res.Output)" "ERROR"
        return $false
    }
    Write-MvLog "Preflight passed: every media root is readable and has free space."
    return $true
}

function Wait-MvTaskState {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("Running", "Ready")][string]$State,
        [int]$TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        $current = if ($task) { [string]$task.State } else { "Ready" }
        # A queued instance has already been admitted and will run, so it counts as live.
        $settled = if ($State -eq "Running") {
            $current -eq "Running"
        } else {
            $current -ne "Running" -and $current -ne "Queued"
        }
        if ($settled) {
            return $true
        }
        if ((Get-Date) -ge $deadline) {
            return $false
        }
        Start-Sleep -Milliseconds 500
    }
}

function Get-MvInternalHealth {
    param([Parameter(Mandatory = $true)][ValidateSet("live", "ready")][string]$Endpoint)
    $res = Invoke-WslBash -Command "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) exec -T caddy wget -q -T 5 -O - http://nginx:8080/health/$Endpoint"
    if ($res.ExitCode -ne 0) { throw "Internal health probe failed ($Endpoint): $($res.Output)" }
    return ($res.Output | ConvertFrom-Json -ErrorAction Stop)
}
