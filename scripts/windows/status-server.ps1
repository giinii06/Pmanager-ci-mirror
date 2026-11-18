$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_common.ps1")

Write-Host "=== Scheduled Task ===" -ForegroundColor Cyan
$task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $script:TaskName
    [pscustomobject]@{
        TaskName       = $task.TaskName
        State          = $task.State
        UserId         = $task.Principal.UserId
        LogonType      = $task.Principal.LogonType
        LastRunTime    = $info.LastRunTime
        LastTaskResult = $info.LastTaskResult
    } | Format-List
} else {
    Write-Host "Scheduled task '$($script:TaskName)' is NOT installed." -ForegroundColor Yellow
}

Write-Host "=== WSL Docker Services ===" -ForegroundColor Cyan
$ps = Invoke-WslBash -Command "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) ps"
Write-Host $ps.Output

Write-Host "=== Health Probe ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "check-health.ps1")
