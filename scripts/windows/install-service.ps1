[CmdletBinding()]
param(
    [string]$OwnerUser = $env:USERNAME,
    [switch]$UsePasswordLogon,
    [switch]$EnableWindowsOpenSSH,
    [switch]$SkipPowerConfig
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_common.ps1")

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Please run install-service.ps1 from an elevated Administrator PowerShell prompt."
}

if (-not (Test-Path $script:StateDir)) {
    New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
}
if (-not (Test-Path $script:LogDir)) {
    New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
}

function Disable-SupersededBootTasks {
    foreach ($supersededBootTask in @("MediaVault-WSL-Boot", "WSL Ubuntu SSH")) {
        if (Get-ScheduledTask -TaskName $supersededBootTask -ErrorAction SilentlyContinue) {
            Disable-ScheduledTask -TaskName $supersededBootTask -ErrorAction SilentlyContinue | Out-Null
            Write-MvLog "Disabled legacy task '$supersededBootTask' in favor of single-owner '$($script:TaskName)'."
        }
    }
}

Disable-SupersededBootTasks

$runnerPath = Join-Path $PSScriptRoot "service-runner.ps1"
$argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerPath`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine
$trigger = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$fullUser = if ($OwnerUser.Contains("\")) { $OwnerUser } else { "$env:COMPUTERNAME\$OwnerUser" }
if ($UsePasswordLogon) {
    $cred = Get-Credential -UserName $fullUser -Message "Enter Windows password for unattended background logon (never stored on disk)"
    $plain = $cred.GetNetworkCredential().Password
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Settings $settings -User $fullUser -Password $plain -RunLevel Highest -Force | Out-Null
} else {
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $fullUser -LogonType S4U -RunLevel Highest
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null
}

if (-not $SkipPowerConfig) {
    & powercfg /change standby-timeout-ac 0 | Out-Null
    & powercfg /change hibernate-timeout-ac 0 | Out-Null
    & powercfg /hibernate off | Out-Null
    Write-MvLog "Configured AC power plan to disable sleep and hibernation."
}

& New-NetFirewallRule -DisplayName "MediaVault Web 8080" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null
& New-NetFirewallRule -DisplayName "MediaVault WSL SSH 22" -Direction Inbound -LocalPort 22 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

if ($EnableWindowsOpenSSH) {
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction SilentlyContinue | Out-Null
    Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service sshd -ErrorAction SilentlyContinue
}

Start-ScheduledTask -TaskName $script:TaskName
Write-Host "Installed and started '$($script:TaskName)' under '$fullUser'." -ForegroundColor Green
Write-Host "Logs: $($script:LogFile)"
