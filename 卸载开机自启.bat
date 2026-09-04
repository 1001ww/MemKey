@echo off
setlocal DisableDelayedExpansion
title MemKey Startup Uninstaller

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\MemKey.vbs"

if not exist "%VBS%" (
  echo No MemKey Startup entry was found.
  pause
  exit /b 0
)

del /f /q "%VBS%" >nul 2>nul
if exist "%VBS%" (
  echo Failed to remove the Startup entry.
  pause
  exit /b 1
)

echo Startup entry removed.
pause
