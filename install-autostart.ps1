$ErrorActionPreference = 'Stop'

$taskName = 'EZ Music Bot'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root 'start-hidden.vbs'

if (-not (Test-Path -LiteralPath $vbs)) {
    throw "Missing start-hidden.vbs in $root"
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

$action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Starts EZ Music hidden at Windows sign-in and restarts it after unexpected failures.'

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

Write-Host ''
Write-Host 'EZ Music autostart installed successfully.' -ForegroundColor Green
Write-Host "Task: $taskName"
Write-Host "User: $user"
Write-Host "Launch: $vbs"
Write-Host ''
Write-Host 'It starts hidden at your next Windows sign-in.'
Write-Host 'To start hidden now, double-click start-hidden.vbs.'
Write-Host 'To stop it, run stop-bot.bat.'
Write-Host 'To remove autostart, run remove-autostart.bat.'
