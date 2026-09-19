@echo off
setlocal enabledelayedexpansion
title Pi Agent
rem ---------------------------------------------------------------------------
rem  Opens the Pi Agent UI in its own window - no build step, no toolchain.
rem
rem  Same UI that start-webui.bat serves, launched in Edge/Chrome "app mode" so
rem  it gets its own window without tabs or an address bar. Use this one when
rem  you do not want to install Visual Studio just for the native shell in
rem  pi-desktop\ (start-app.bat). Falls back to the default browser.
rem
rem  The bridge is started automatically when nothing listens on PORT.
rem ---------------------------------------------------------------------------

set "PORT=3080"
set "URL=http://localhost:%PORT%/"

set "BRIDGE_UP="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":%PORT% "') do set "BRIDGE_UP=%%P"
if defined BRIDGE_UP goto open

echo.
echo   The bridge is not running - starting it in a second window.
echo.
start "Pi Agent WebUI" "%~dp0start-webui.bat"
for /l %%I in (1,1,45) do (
  timeout /t 1 /nobreak >nul
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":%PORT% "') do set "BRIDGE_UP=%%P"
  if defined BRIDGE_UP goto open
)
echo   The bridge is taking a while (a first run installs dependencies).
echo   Opening the window anyway - reload it once the bridge settles.

:open
rem  Chrome and Edge live in different places depending on the install. Two rules
rem  are being followed here, because both used to break this script:
rem   1. no bracketed if/for blocks around these paths - a ")" inside a value like
rem      "C:\Program Files (x86)" ends the block early (that is the
rem      "... was unexpected at this time" error), and
rem   2. !var! instead of %var% wherever a path is echoed or passed on, since
rem      delayed expansion keeps brackets in the value from being parsed.
set "BROWSER="
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "!ProgramFiles(x86)!\Microsoft\Edge\Application\msedge.exe" set "BROWSER=!ProgramFiles(x86)!\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "!ProgramFiles(x86)!\Google\Chrome\Application\chrome.exe" set "BROWSER=!ProgramFiles(x86)!\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not defined BROWSER goto no_browser
echo   Opening %URL% as an app window...
start "" "!BROWSER!" --app=!URL! --window-size=1280,880
exit /b 0

:no_browser
echo   No Edge or Chrome found - opening in the default browser instead.
start "" "%URL%"
exit /b 0
