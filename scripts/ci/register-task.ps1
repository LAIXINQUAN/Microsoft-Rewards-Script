<#
.SYNOPSIS
  Register the GitHub Actions sign-in watchdog scheduled task (runs every 30 minutes).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\register-task.ps1
#>
$ErrorActionPreference = "Stop"

$taskName = "RewardsDailyDispatcher"
$repo     = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "deepseek-harness\default-workspace\ms-rewards"
$script   = Join-Path $repo "scripts\ci\ensure-daily-run.mjs"
$node     = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

if (-not (Test-Path $script)) { throw "dispatcher script not found: $script" }
if (-not (Test-Path $node))   { throw "node not found: $node" }

$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '"') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) `
             -RepetitionInterval (New-TimeSpan -Minutes 30) `
             -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -MultipleInstances IgnoreNew `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$task = New-ScheduledTask -Action $action -Trigger @($trigger) -Settings $settings `
          -Description "GitHub Actions sign-in watchdog: every 30 min check rewards-daily and kgcheckin, dispatch if today not succeeded"

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

$t = Get-ScheduledTask -TaskName $taskName
Write-Host ("registered: " + $t.TaskName + " / " + $t.State)
Write-Host ("next run : " + (Get-ScheduledTaskInfo -TaskName $taskName).NextRunTime)
Write-Host "run now  : Start-ScheduledTask -TaskName $taskName"
Write-Host "log      : Get-Content (Join-Path $env:USERPROFILE '.rewards-dispatcher\log.txt') -Tail 20 -Encoding UTF8"
Write-Host "remove   : powershell -File scripts\ci\unregister-task.ps1"
