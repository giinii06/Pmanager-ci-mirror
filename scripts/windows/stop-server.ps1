$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_common.ps1")

if (-not (Test-Path $script:StateDir)) {
    New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
}
Set-Content -Path $script:StopFlag -Value (Get-Date).ToString("o") -Encoding UTF8

$task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
}

$res = Invoke-WslBash -Command "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) stop"
if ($res.ExitCode -ne 0) {
    throw "Failed stopping containers: $($res.Output)"
}
Write-Host "MediaVault services stopped gracefully."
