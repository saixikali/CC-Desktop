@echo off
rem ===========================================================================
rem  CC Desktop pet launcher -- thin ASCII-only forwarder.
rem
rem  Keep this file tiny and pure ASCII:
rem    * cmd.exe decodes .bat with the system ANSI codepage (GBK on Chinese
rem      Windows), so UTF-8 Chinese comments turn into garbage and shred the
rem      command lines.
rem    * cmd's quoting/parenthesis parsing is fragile around PowerShell calls.
rem  So ALL logic lives in pet.py; this file only forwards.
rem ===========================================================================

setlocal
set "PYW=%LOCALAPPDATA%\Programs\Python\pythonw.exe"
if not exist "%PYW%" set "PYW=C:\Python314\pythonw.exe"
if not exist "%PYW%" (
  for %%P in (pythonw.exe) do if not defined PYW set "PYW=%%~$PATH:P"
)

rem ---- launch.
rem  --wait-for-app implies "follow the app lifecycle": the pet waits for
rem  CC Desktop to appear, then exits when CC Desktop exits -- so it never
rem  turns into an orphan window left behind on the desktop.
set "FOLLOW="
echo %* | findstr /C:"--wait-for-app" >nul 2>&1
if not errorlevel 1 set "FOLLOW=--watch-app"

if not exist "%PYW%" (
  echo [pet] pythonw.exe not found -- falling back to python.exe
  python "%~dp0pet.py" %* %FOLLOW%
  exit /b %errorlevel%
)

start "" "%PYW%" "%~dp0pet.py" %* %FOLLOW%
exit /b 0
