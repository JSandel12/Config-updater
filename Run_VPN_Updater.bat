@echo off
echo ==============================================
echo   Starting VPN Background Checker (1000 limit)
echo ==============================================
cd /d "%~dp0"
set TEST_LIMIT=2000
node index.js
echo.
echo Finished! Press any key to exit...
pause >nul
