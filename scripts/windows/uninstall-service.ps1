$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_common.ps1")

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Please run uninstall-service.ps1 from an elevated Administrator PowerShell prompt."
}

& (Join-Path $PSScriptRoot "stop-server.ps1") -ErrorAction SilentlyContinue
if (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$($script:TaskName)'."
} else {
    Write-Host "Scheduled task '$($script:TaskName)' was not registered."
}
if (Test-Path $script:BinDir) {
    Remove-Item -Path $script:BinDir -Recurse -Force -ErrorAction SilentlyContinue
}
