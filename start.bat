@echo off
chcp 65001 >nul
title MemKey 本地密码保险库
cd /d "%~dp0"
echo 正在启动 MemKey 服务...
node server.js --open
pause
