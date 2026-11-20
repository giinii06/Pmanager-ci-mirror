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
if (-not (Test-Path $script:BinDir)) {
    New-Item -ItemType Directory -Path $script:BinDir -Force | Out-Null
}
if (-not (Test-Path $script:LogDir)) {
    New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
}

Get-ChildItem -Path $PSScriptRoot -Filter "*.ps1" | Copy-Item -Destination $script:BinDir -Force
Get-ChildItem -Path $script:BinDir -Filter "*.ps1" | Unblock-File -ErrorAction SilentlyContinue

function Disable-SupersededBootTasks {
    foreach ($supersededBootTask in @("MediaVault-WSL-Boot", "WSL Ubuntu SSH")) {
        if (Get-ScheduledTask -TaskName $supersededBootTask -ErrorAction SilentlyContinue) {
            Disable-ScheduledTask -TaskName $supersededBootTask -ErrorAction SilentlyContinue | Out-Null
            Write-MvLog "Disabled legacy task '$supersededBootTask' in favor of single-owner '$($script:TaskName)'."
        }
    }
}

function Ensure-WslIdleConfig {
    param([Parameter(Mandatory = $true)][string]$UserName)
    $shortUser = if ($UserName.Contains("\")) { $UserName.Split("\")[-1] } else { $UserName }
    $profileDir = "C:\Users\$shortUser"
    if (-not (Test-Path $profileDir)) {
        Write-MvLog "User profile directory '$profileDir' not found; skipping .wslconfig update." "WARN"
        return
    }
    $wslConfigPath = Join-Path $profileDir ".wslconfig"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    if (-not (Test-Path $wslConfigPath)) {
        [System.IO.File]::WriteAllText($wslConfigPath, "[wsl2]`r`nvmIdleTimeout=-1`r`n", $utf8NoBom)
        Write-MvLog "Created '$wslConfigPath' with vmIdleTimeout=-1."
        return
    }
    $existing = [System.IO.File]::ReadAllText($wslConfigPath)
    if ($existing -match '(?im)^\s*vmIdleTimeout\s*=') {
        return
    }
    if ($existing -match '(?im)^\[wsl2\]\s*$') {
        $updated = [regex]::Replace($existing, '(?im)(^\[wsl2\]\s*\r?\n?)', "`$1vmIdleTimeout=-1`r`n", 1)
    } else {
        $sep = if ($existing.EndsWith("`n") -or $existing -eq "") { "" } else { "`r`n" }
        $updated = "${existing}${sep}[wsl2]`r`nvmIdleTimeout=-1`r`n"
    }
    [System.IO.File]::WriteAllText($wslConfigPath, $updated, $utf8NoBom)
    Write-MvLog "Updated '$wslConfigPath' with vmIdleTimeout=-1."
}

Disable-SupersededBootTasks
Ensure-WslIdleConfig -UserName $OwnerUser
Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
if (-not (Wait-MvTaskState -State "Ready")) {
    throw "Supervisor task '$($script:TaskName)' did not stop within 30 seconds; re-registering it would leave the old instance running. Check '$($script:LogFile)' and the Task Scheduler history."
}

$psExe = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
$runnerPath = Join-Path $script:BinDir "service-runner.ps1"
$argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerPath`""
$action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine -WorkingDirectory $script:BinDir
$fullUser = if ($OwnerUser.Contains("\")) { $OwnerUser } else { "$env:COMPUTERNAME\$OwnerUser" }
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $fullUser)
)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

if ($UsePasswordLogon) {
    $cred = Get-Credential -UserName $fullUser -Message "Enter Windows password for unattended background logon (never stored on disk)"
    $plain = $cred.GetNetworkCredential().Password
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $triggers -Settings $settings -User $fullUser -Password $plain -RunLevel Highest -Force | Out-Null
} else {
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $fullUser -LogonType S4U -RunLevel Highest
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $taskPrincipal -Force | Out-Null
}

if (-not (Wait-MvTaskState -State "Ready")) {
    throw "Supervisor task '$($script:TaskName)' still has a live instance after re-registration, so the start below would be dropped by -MultipleInstances IgnoreNew. Check '$($script:LogFile)'."
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
if (-not (Wait-MvTaskState -State "Running")) {
    $taskInfo = Get-ScheduledTaskInfo -TaskName $script:TaskName -ErrorAction SilentlyContinue
    $lastResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { -1 }
    throw "Supervisor task '$($script:TaskName)' did not reach Running within 30 seconds (LastTaskResult=$lastResult). Check '$($script:LogFile)'."
}

$task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
$taskState = if ($task) { [string]$task.State } else { "Missing" }
$taskInfo = Get-ScheduledTaskInfo -TaskName $script:TaskName -ErrorAction SilentlyContinue
$lastResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { -1 }

Write-Host "Installed and started '$($script:TaskName)' under '$fullUser'." -ForegroundColor Green
Write-Host "State: $taskState | LastTaskResult: $lastResult | StagedRunner: $runnerPath"
Write-Host "Logs: $($script:LogFile)"
if ($taskState -ne "Running") {
    Write-Warning "Task '$($script:TaskName)' is '$taskState' (LastTaskResult=$lastResult). Check '$($script:LogFile)'."
} elseif (Test-Path $script:LogFile) {
    Get-Content -Path $script:LogFile -Tail 5 | ForEach-Object { Write-Host "  $_" }
}
