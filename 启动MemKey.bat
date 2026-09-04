@echo off
setlocal DisableDelayedExpansion
title MemKey
cd /d "%~dp0"

if not exist "server.js" (
  echo server.js was not found in this folder.
  pause
  exit /b 1
)

if not exist "memkey-launch.vbs" (
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

start "" /b wscript.exe "%~dp0memkey-launch.vbs" --notify
if errorlevel 1 (
  echo Failed to start MemKey.
  pause
  exit /b 1
)

exit /b 0
