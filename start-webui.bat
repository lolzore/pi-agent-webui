@echo off
setlocal enabledelayedexpansion
title Pi Agent WebUI
rem Pi Agent WebUI launcher.
rem
rem First run (or after switch_pi_agent_source.bat): pick where the pi agent
rem lives - natively on Windows, or inside a Docker container. The choice is
rem saved to bridge\agent-source.txt and reused on later launches.

cd /d "%~dp0bridge"
rem The agent's working directory is the repo root (not bridge\), since that is
rem the project the WebUI is meant to work on. %%~fI drops the trailing slash.
for %%I in ("%~dp0.") do set "ROOT=%%~fI"
if not exist node_modules (
  echo Installing bridge dependencies...
  call npm install --no-fund --no-audit
)

set "SOURCE_FILE=%~dp0bridge\agent-source.txt"
set "SOURCE="
set "CONTAINER="

rem -- reuse a saved choice unless switch_pi_agent_source.bat deleted it --
if exist "%SOURCE_FILE%" if "%~1"=="" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%SOURCE_FILE%") do (
    if /i "%%A"=="source" set "SOURCE=%%B"
    if /i "%%A"=="container" set "CONTAINER=%%B"
  )
)
if /i "!SOURCE!"=="native" goto :native
if /i "!SOURCE!"=="docker" if not "!CONTAINER!"=="" goto :docker

:choose
set "SOURCE="
echo.
echo  Where does your pi agent run?
echo    1. Natively on Windows  (pi CLI installed, no Docker)
echo    2. Inside a Docker container
choice /c 12 /n /m "Select [1/2]: "
rem An explicit answer only: choice returns 255 when there is no input at all
rem (a script or shortcut with a redirected stdin), and "errorlevel 2" would
rem then send it down the Docker path.
if "!errorlevel!"=="1" goto :choose_native
if "!errorlevel!"=="2" goto :choose_docker
echo.
echo  No selection made - nothing changed.
pause
exit /b 1

:choose_native
set "SOURCE=native"
>"%SOURCE_FILE%" echo source=native
goto :native

:choose_docker
set "SOURCE=docker"
where docker >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Docker is not installed, or not on PATH.
  echo  Install Docker Desktop, or run this again and pick 1 to use a pi that is
  echo  installed on Windows.
  pause
  exit /b 1
)
echo.
echo  Containers on this machine:
set /a i=1
for /f "tokens=1,2,3" %%A in ('docker ps -a --format "{{.Names}} {{.Image}} {{.Status}}"') do (
  set "name_!i!=%%A"
  echo    !i!. %%A  [%%B]
  set /a i+=1
)
set /a count=i-1
if !count! LSS 1 (
  echo  No Docker containers found.
  pause
  exit /b 1
)
set "PICK="
set /p PICK="Pick container number [1-!count!]: "
if not defined PICK (
  echo  No selection made.
  pause
  exit /b 1
)
set /a idx=1
for /f "tokens=1" %%A in ('docker ps -a --format "{{.Names}}"') do (
  if !idx! EQU !PICK! set "CONTAINER=%%A"
  set /a idx+=1
)
if not defined CONTAINER (
  echo  Invalid selection.
  pause
  exit /b 1
)
rem sanity: does the chosen container have pi?
docker exec "!CONTAINER!" sh -c "command -v pi >/dev/null 2>&1" >nul 2>nul
if errorlevel 1 echo  WARNING: no "pi" command found inside "!CONTAINER!" - it may still work if pi is on another path.
>"%SOURCE_FILE%" echo source=docker
>>"%SOURCE_FILE%" echo container=!CONTAINER!

:docker
:native
if /i "!SOURCE!"=="native" (
  where pi >nul 2>nul
  if errorlevel 1 (
    echo ERROR: "pi" was not found on PATH.
    echo        Install it with: npm install -g @mariozechner/pi-coding-agent
    pause
    exit /b 1
  )
  echo Using natively installed pi CLI.
  set "PI_COMMAND=pi --mode rpc"
  set "PI_SESSION_DIR=!USERPROFILE!\.pi\agent\sessions"
) else (
  echo Using Docker container "!CONTAINER!".
  docker start "!CONTAINER!" >nul 2>nul
  set "PI_COMMAND=docker exec -i !CONTAINER! pi --mode rpc"
  set "PI_SESSION_DIR=docker:!CONTAINER!:/root/.pi/agent/sessions"
)

set PORT=3080

rem -- if an older bridge is still holding the port, offer to stop it --
set "OLD_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":!PORT! "') do set "OLD_PID=%%P"
if defined OLD_PID (
  echo.
  echo  A previous Pi Agent WebUI is still listening on port !PORT! ^(PID !OLD_PID!^).
  choice /c yn /n /m "Stop it and start a fresh one? [y/n]: "
  rem Only an explicit "y" stops it: choice returns 255 when there is no input
  rem (a script launching this with a redirected stdin, say), which must not be
  rem read as permission to kill a bridge that may be in the middle of a turn.
  if not "!errorlevel!"=="1" (
    echo  Leaving the running WebUI alone.
    pause
    exit /b 0
  )
  taskkill /PID !OLD_PID! /T /F >nul 2>nul
  echo  Stopped PID !OLD_PID!.
  timeout /t 1 >nul
)

echo.
echo Pi Agent WebUI starting on http://localhost:3080
echo (to change the pi agent source later, run switch_pi_agent_source.bat)
endlocal & (
  set "PI_COMMAND=%PI_COMMAND%"
  set "PI_SESSION_DIR=%PI_SESSION_DIR%"
  set "PORT=%PORT%"
  set "WORKSPACE_DIR=%ROOT%"
)
echo.
echo  Pi Agent WebUI is running at  http://localhost:%PORT%
echo  agent workspace : %WORKSPACE_DIR%
echo.
echo  To STOP it: press Ctrl+C in this window, or close this window.
echo  (stopping also kills the pi agent + whisper server - nothing is left running)
echo.
node "%~dp0bridge\server.js"
echo.
echo  Pi Agent WebUI stopped.
timeout /t 2 >nul
pause
