@echo off
setlocal enabledelayedexpansion
title Pi Agent - Desktop App (React Native for Windows)
rem ---------------------------------------------------------------------------
rem  Launches the native Pi Agent app (the React Native one in pi-desktop\).
rem
rem  This is the Windows build of the same app that runs on Android/iOS - one
rem  React Native codebase, three targets. It talks to the same bridge as the
rem  WebUI, so start-webui.bat must be running.
rem
rem  The first run builds the app, which takes a while: it compiles the C++
rem  React Native Windows runtime and the native modules.
rem ---------------------------------------------------------------------------

set "EXE=%~dp0pi-desktop\windows\x64\Release\PiAgent.exe"
set "PROJ=%~dp0pi-desktop"

rem --- is the bridge up? -----------------------------------------------------
set "BRIDGE_UP="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":3080 "') do set "BRIDGE_UP=%%P"
if not defined BRIDGE_UP (
  echo.
  echo   The bridge is not running on port 3080.
  echo   The app needs it for the agent connection.
  echo.
  choice /c yn /m "  Start the bridge now (a second window)"
  if !errorlevel! equ 1 (
    start "Pi Agent WebUI" "%~dp0start-webui.bat"
    echo   Waiting for the bridge...
    for /l %%I in (1,1,40) do (
      timeout /t 1 /nobreak >nul
      for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":3080 "') do set "BRIDGE_UP=%%P"
      if defined BRIDGE_UP goto bridge_ok
    )
    echo   Still not up - continuing anyway, you can connect later from the app's setup screen.
  )
)
:bridge_ok

rem --- dependencies present? -------------------------------------------------
if not exist "%PROJ%\node_modules" (
  echo   Installing the app's dependencies first - first run only...
  pushd "%PROJ%"
  call npm install --no-fund --no-audit
  set "INSTALL_RC=!errorlevel!"
  popd
  if not "!INSTALL_RC!"=="0" (
    echo.
    echo   npm install failed - check your network / npm registry.
    pause
    exit /b 1
  )
)

rem --- built already? --------------------------------------------------------
if exist "%EXE%" goto launch

echo.
echo   The app has not been built yet.
echo   Building it now. This can take 5-20 minutes the first time.
echo.
pushd "%PROJ%"
call npm run windows:release
set "BUILD_RC=!errorlevel!"
popd
if not "!BUILD_RC!"=="0" (
  echo.
  echo   Build failed. See pi-desktop\README.md ^> "Building for Windows".
  pause
  exit /b 1
)
if not exist "%EXE%" (
  echo.
  echo   Build reported success but %EXE% is missing.
  pause
  exit /b 1
)

:launch
echo.
echo  ==========================================================
echo   Pi Agent - desktop app
echo  ==========================================================
echo.
echo   Start the app... (the window opens in a moment)
echo   In the app's setup screen enter your PC's IP and port 3080.
echo.
start "" "%EXE%"
exit /b 0
