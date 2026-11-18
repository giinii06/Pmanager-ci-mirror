Set-StrictMode -Version Latest

$script:WslDistro = if ($env:MV_WSL_DISTRO) { $env:MV_WSL_DISTRO } else { "Ubuntu-24.04" }
$script:WslUser = if ($env:MV_WSL_USER) { $env:MV_WSL_USER } else { "giini" }
$script:RepoDir = if ($env:MV_REPO_DIR) { $env:MV_REPO_DIR } else { "/home/giini/Pmanager" }
$script:TaskName = "MediaVault-Supervisor"
$script:StateDir = "C:\ProgramData\MediaVault"
$script:LogDir = "C:\ProgramData\MediaVault\logs"
$script:LogFile = "C:\ProgramData\MediaVault\logs\supervisor.log"
$script:StopFlag = "C:\ProgramData\MediaVault\stop.flag"
$script:ComposeArgs = @(
    "--env-file .env",
    "--env-file .env.asr",
    "--env-file .env.translation",
    "--env-file .env.embedding",
    "--env-file .env.scene",
    "-f compose.yaml",
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
    $output = & wsl.exe -d $script:WslDistro -u $targetUser -- bash -lc $Command 2>&1
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = ($output -join "`n")
    }
}
