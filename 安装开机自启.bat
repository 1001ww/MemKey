@echo off
setlocal DisableDelayedExpansion
title MemKey Startup Installer

set "APP_DIR=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\MemKey.vbs"

if not exist "%APP_DIR%server.js" (
  echo server.js was not found in this folder.
  pause
  exit /b 1
)

if not exist "%APP_DIR%memkey-launch.vbs" (
  echo memkey-launch.vbs was not found in this folder.
  pause
  exit /b 1
)

where.exe node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node.js, restart Windows, then run this script again.
  pause
  exit /b 1
)

> "%VBS%" (
  echo Set shell = CreateObject^("WScript.Shell"^)
  echo shell.Run "wscript.exe ""%APP_DIR%memkey-launch.vbs""", 0, False
)

if not exist "%VBS%" (
  echo The Startup entry was not created.
  pause
  exit /b 1
)

echo Startup entry installed:
echo %VBS%
echo.
echo MemKey will start silently after you sign in.
pause
