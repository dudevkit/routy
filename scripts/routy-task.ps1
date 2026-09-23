<#
.SYNOPSIS
  Register / remove / inspect the routy gateway as a Windows scheduled task.

.DESCRIPTION
  Runs the gateway as a background process that starts with the machine (or at
  logon) and restarts after a crash. No third-party service wrapper required.

  Graceful stop uses the gateway's own endpoint (POST /api/gateway/shutdown)
  because Windows has no SIGTERM: terminating a console process is a hard kill
  and skips the drain. Always prefer -Action stop over `taskkill`.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\routy-task.ps1 -Action install
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\routy-task.ps1 -Action install -AtStartup -Port 8010
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\routy-task.ps1 -Action stop
#>
[CmdletBinding()]
param(
  [ValidateSet("install", "uninstall", "start", "stop", "status")]
  [string]$Action = "status",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Home = "$env:USERPROFILE\.routy",
  [int]$Port = 8010,
  # AtStartup needs an elevated shell and runs as SYSTEM; default is at-logon.
  [switch]$AtStartup
)

$ErrorActionPreference = "Stop"
$TaskName = "routy Gateway"
$Launcher = Join-Path $PSScriptRoot "routy-serve.cmd"
$BaseUrl = "http://127.0.0.1:$Port"

function Get-Task {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Stop-Gracefully {
  # Drain in-flight streams through the gateway's own shutdown route.
  try {
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/gateway/shutdown" -TimeoutSec 5 | Out-Null
    Write-Host "Requested graceful shutdown."
  } catch {
    Write-Warning "Gateway did not answer the shutdown request ($($_.Exception.Message)). It may already be stopped."
  }
}

switch ($Action) {
  "install" {
    if (-not (Test-Path $Launcher)) { throw "Launcher not found: $Launcher" }
    if (Get-Task) { Write-Host "Task '$TaskName' already exists - replacing."; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

    $action = New-ScheduledTaskAction -Execute $Launcher -Argument "`"$RepoRoot`" `"$Home`" $Port" -WorkingDirectory (Join-Path $RepoRoot "routy-core")
    $trigger = if ($AtStartup) { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME }
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
      -StartWhenAvailable

    $principal = if ($AtStartup) {
      New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    } else {
      New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    }

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
      -Description "routy AI gateway (re-engineering of 9Router). Restart-on-failure; graceful stop via $BaseUrl/api/gateway/shutdown." | Out-Null
    Write-Host "Installed scheduled task '$TaskName' ($(if ($AtStartup) { 'at startup, as SYSTEM' } else { "at logon for $env:USERNAME" }))."
    Write-Host "Start it with:  powershell -File scripts\routy-task.ps1 -Action start"
  }

  "uninstall" {
    Stop-Gracefully
    if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "Removed scheduled task '$TaskName'." }
    else { Write-Host "No task named '$TaskName'." }
  }

  "start" {
    if (-not (Get-Task)) { throw "Task '$TaskName' is not installed. Run -Action install first." }
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started '$TaskName'."
  }

  "stop" {
    Stop-Gracefully
    if (Get-Task) { Stop-ScheduledTask -TaskName $TaskName; Write-Host "Stopped '$TaskName'." }
  }

  "status" {
    $t = Get-Task
    if (-not $t) { Write-Host "Task '$TaskName': not installed."; break }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Task        : $TaskName"
    Write-Host "State       : $($t.State)"
    Write-Host "Last run    : $($info.LastRunTime)  result=$($info.LastTaskResult)"
    Write-Host "Next run    : $($info.NextRunTime)"
    try {
      $g = Invoke-RestMethod -Uri "$BaseUrl/api/gateway" -TimeoutSec 3
      Write-Host "Gateway     : online (uptime $([math]::Round($g.uptimeMs / 1000))s)"
    } catch {
      Write-Host "Gateway     : not answering on $BaseUrl"
    }
  }
}
