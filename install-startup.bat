@echo off
chcp 65001 >nul
title MemKey 开机自启 - 安装
setlocal
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\MemKey.vbs"

> "%VBS%" (
  echo Set sh = CreateObject^("WScript.Shell"^)
  echo sh.CurrentDirectory = "%~dp0"
  echo sh.Run "node ""%~dp0server.js""", 0, False
)

echo ========================================
echo  已安装开机自启：%VBS%
echo.
echo  开机后服务将在后台静默运行（无弹窗）
echo  访问 http://localhost:8420 即可使用
echo ========================================
pause
