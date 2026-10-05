@echo off
setlocal
cd /d "%~dp0"

REM Starts the WebUI for every device on this local network.
REM The bridge only listens on all interfaces because this file asks it to;
REM a normal start-webui.bat run stays on 127.0.0.1.
set PI_WEBUI_HOST=0.0.0.0

echo.
echo  WebUI is exposed to the whole local network.
echo  Anyone on this network can use it - there is no login.
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do echo    http://%%a:3080
echo.

call "%~dp0start-webui.bat" %*
endlocal
