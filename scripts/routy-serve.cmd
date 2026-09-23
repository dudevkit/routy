@echo off
rem routy gateway launcher - used by Task Scheduler (scripts\routy-task.ps1).
rem Args: <repo-root> <routy-home> <port>
rem Kept as a .cmd so Task Scheduler does not have to quote a PowerShell one-liner.
setlocal
set "REPO=%~1"
set "ROUTY_HOME=%~2"
set "PORT=%~3"
if "%REPO%"=="" set "REPO=%~dp0.."
if "%ROUTY_HOME%"=="" set "ROUTY_HOME=%USERPROFILE%\.routy"
if not "%PORT%"=="" set "ROUTY_PORT=%PORT%"
cd /d "%REPO%\routy-core"
node server.mjs
