@echo off
:: ============================================================
:: WordPad Pro — Local Updater v1.1.0
:: Double-click → Right-click → Run as Administrator
:: ============================================================

title WordPad Pro Updater

:: Check for Administrator privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: This script must be run as Administrator.
    echo  Right-click this file and choose "Run as administrator"
    echo.
    pause
    exit /b 1
)

set "PROJECT=D:\Jain Word Project\wordpad-pro-source\wordpad-app"
set "DIST=%PROJECT%\dist"

echo.
echo  ============================================================
echo   WordPad Pro Local Updater v1.1.0
echo  ============================================================
echo.

:: Verify project folder exists
if not exist "%PROJECT%" (
    echo  ERROR: Project folder not found at:
    echo  %PROJECT%
    echo.
    pause
    exit /b 1
)

echo  Project: %PROJECT%
echo.

:: Close WordPad Pro if running
echo  [1/4] Closing WordPad Pro if running...
tasklist /fi "imagename eq WordPad Pro.exe" 2>nul | find /i "WordPad Pro.exe" >nul
if %errorlevel% equ 0 (
    taskkill /f /im "WordPad Pro.exe" >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo        Closed.
) else (
    echo        Not running - skipping.
)

:: Navigate to project and build
echo.
echo  [2/4] Building installer...
echo  (This may take 1-2 minutes - please wait)
echo.
cd /d "%PROJECT%"
call npm run build-win
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Build failed. Check the output above for errors.
    echo.
    pause
    exit /b 1
)

echo.
echo  [3/4] Build complete. Locating installer...

:: Find the installer - searches for any Setup exe in dist folder
for %%f in ("%DIST%\WordPad Pro Setup*.exe") do set "INSTALLER=%%f"

if not defined INSTALLER (
    echo.
    echo  ERROR: No installer found in:
    echo  %DIST%
    echo.
    pause
    exit /b 1
)

echo        Found: %INSTALLER%
echo.

:: Launch installer
echo  [4/4] Launching installer...
echo.
start "" "%INSTALLER%"

echo  Installer launched successfully.
echo.
echo  ============================================================
echo   TIP: If upgrading, uninstall the old version first
echo   to see the full setup wizard with shortcut options.
echo  ============================================================
echo.
pause
