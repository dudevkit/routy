@echo off
rem RE-E gateway launcher - used by Task Scheduler (scripts\re-e-task.ps1).
rem Args: <repo-root> <re-e-home> <port>
rem Kept as a .cmd so Task Scheduler does not have to quote a PowerShell one-liner.
setlocal
set "REPO=%~1"
set "RE_E_HOME=%~2"
set "PORT=%~3"
if "%REPO%"=="" set "REPO=%~dp0.."
if "%RE_E_HOME%"=="" set "RE_E_HOME=%USERPROFILE%\.re-e"
if not "%PORT%"=="" set "RE_E_PORT=%PORT%"
cd /d "%REPO%\re-e-core"
node server.mjs
