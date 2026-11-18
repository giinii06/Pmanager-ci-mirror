$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_common.ps1")

& (Join-Path $PSScriptRoot "stop-server.ps1")
Start-Sleep -Seconds 2
& (Join-Path $PSScriptRoot "start-server.ps1")
