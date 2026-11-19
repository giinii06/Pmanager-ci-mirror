$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_common.ps1")

if (Test-Path $script:StopFlag) {
    Remove-Item -Path $script:StopFlag -Force
}

$task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
if ($task) {
    Start-ScheduledTask -TaskName $script:TaskName
    Write-Host "Started scheduled task '$($script:TaskName)'."
} else {
    $null = Invoke-WslBash -Command "systemctl start docker ssh || true" -AsRoot
    if (-not (Test-MvPreflight)) {
        throw "Preflight failed; see $($script:LogFile)"
    }
    $res = Invoke-WslBash -Command "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) up -d"
    if ($res.ExitCode -ne 0) { throw $res.Output }
    Write-Host "Started MediaVault Compose stack directly (supervisor task not yet installed)."
}
