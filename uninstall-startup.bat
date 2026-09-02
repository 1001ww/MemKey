@echo off
chcp 65001 >nul
title MemKey 开机自启 - 卸载
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MemKey.vbs"
if exist "%VBS%" (
  del "%VBS%"
  echo 已卸载开机自启。
) else (
  echo 未找到开机自启项，无需卸载。
)
pause
