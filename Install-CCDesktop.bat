@echo off
chcp 65001 >nul
title CC Desktop Installer
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%Install-CCDesktop.ps1"

if not exist "%PS1%" (
    echo.
    echo ERROR: Install-CCDesktop.ps1 not found.
    echo Please run this batch file from the extracted CC Desktop source folder.
    echo.
    pause
    exit /b 1
)

echo.
echo  CC Desktop Installer
echo  ====================
echo.
echo  This will build and install CC Desktop on your PC.
echo  You need Node.js 22.18 or newer installed first.
echo.
echo  Press any key to continue, or close this window to cancel.
pause >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
if %errorlevel% neq 0 (
    echo.
    echo  Installation failed. See the messages above.
    echo.
    pause
    exit /b %errorlevel%
)

echo.
echo  Installation completed successfully.
echo.
pause
