<#
.SYNOPSIS
  Remove the GitHub Actions sign-in watchdog scheduled task.
#>
$ErrorActionPreference = "Continue"
$taskName = "RewardsDailyDispatcher"
$t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($t) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host ("removed scheduled task: " + $taskName)
} else {
  Write-Host ("scheduled task not found: " + $taskName)
}
