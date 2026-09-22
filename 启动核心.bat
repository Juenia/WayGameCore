@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 WayGame 核心...
node server.js
pause