@echo off
:: ============================================================
:: JainDocument — Local Updater v1.1.0
:: Double-click → Right-click → Run as Administrator
:: ============================================================

title JainDocument Updater

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
echo   JainDocument Local Updater v1.1.0
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

:: Close JainDocument if running
echo  [1/4] Closing JainDocument if running...
tasklist /fi "imagename eq JainDocument.exe" 2>nul | find /i "JainDocument.exe" >nul
if %errorlevel% equ 0 (
    taskkill /f /im "JainDocument.exe" >nul 2>&1
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

:: Find installer dynamically - works for any version number
for %%f in ("%DIST%\JainDocument Setup*.exe") do set "INSTALLER=%%f"

if not defined INSTALLER (
    echo.
    echo  ERROR: No installer found in %DIST%
    echo.
    pause
    exit /b 1
)

echo        Found: %INSTALLER%
echo.

:: Launch installer and wait for it to complete
echo  [4/4] Launching installer...
echo.
echo  ============================================================
echo   Installation starting now.
echo   Choose your folder and click Install, then Finish.
echo  ============================================================
echo.

start /wait "" "%INSTALLER%"

echo.
echo  ============================================================
echo   JainDocument has been updated successfully.
echo  ============================================================
echo.
pause
