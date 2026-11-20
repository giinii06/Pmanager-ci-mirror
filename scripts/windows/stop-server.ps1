$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_common.ps1")

if (-not (Test-Path $script:StateDir)) {
    New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
}
Set-Content -Path $script:StopFlag -Value (Get-Date).ToString("o") -Encoding UTF8

Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
if (-not (Wait-MvTaskState -State "Ready")) {
    throw "Supervisor task '$($script:TaskName)' did not stop within 30 seconds; refusing to stop containers because the live supervisor would start them again. Check '$($script:LogFile)'."
}

$res = Invoke-WslBash -Command "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) stop"
if ($res.ExitCode -ne 0) {
    throw "Failed stopping containers: $($res.Output)"
}
Write-Host "MediaVault services stopped gracefully."
