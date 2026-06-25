@echo off
echo ==============================================
echo   VPN Database Rollback Utility
echo ==============================================
echo.
echo WARNING: This will overwrite your current Supabase working_links
echo with the contents of backup_links.json in this directory!
echo.
set /p CONTINUE="Are you sure you want to restore the database? (Y/N): "
if /i "%CONTINUE%" neq "Y" (
    echo.
    echo Restore cancelled.
    pause
    exit /b
)

echo.
echo Restoring...
cd /d "%~dp0"
node src/restore.js

echo.
echo Finished! Press any key to exit...
pause >nul
