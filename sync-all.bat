@echo off
title Jain Office Suite - Sync to EXE Folder
color 0A
echo.
echo =============================================
echo  Jain Office Suite - Sync to EXE Folder
echo =============================================
echo.

set SRC_DOC=D:\Jain Office Suite\Jain Office Suite\jaindocument
set SRC_SHT=D:\Jain Office Suite\Jain Office Suite\jainsheet
set EXE_DOC=D:\Jain Office Suite EXE Folder\resources\jaindocument
set EXE_SHT=D:\Jain Office Suite EXE Folder\resources\jainsheet

if not exist "%SRC_DOC%" ( echo ERROR: %SRC_DOC% not found & pause & exit /b 1 )
if not exist "%SRC_SHT%" ( echo ERROR: %SRC_SHT% not found & pause & exit /b 1 )
if not exist "%EXE_DOC%" ( echo ERROR: %EXE_DOC% not found & pause & exit /b 1 )
if not exist "%EXE_SHT%" ( echo ERROR: %EXE_SHT% not found & pause & exit /b 1 )

echo NOTE: Launcher is packaged as app.asar - skipping launcher sync.
echo       Rebuild JainOffice Setup.exe to update the launcher.
echo.

echo ------------------------------------------
echo  Syncing JainDocument...
echo ------------------------------------------

if not exist "%EXE_DOC%\src" mkdir "%EXE_DOC%\src"

copy /y "%SRC_DOC%\main.js"      "%EXE_DOC%\main.js"      >nul && echo   OK  main.js
copy /y "%SRC_DOC%\preload.js"   "%EXE_DOC%\preload.js"   >nul && echo   OK  preload.js
copy /y "%SRC_DOC%\package.json" "%EXE_DOC%\package.json" >nul && echo   OK  package.json

copy /y "%SRC_DOC%\src\app.js"                   "%EXE_DOC%\src\app.js"                   >nul && echo   OK  src\app.js
copy /y "%SRC_DOC%\src\index.html"               "%EXE_DOC%\src\index.html"               >nul && echo   OK  src\index.html
copy /y "%SRC_DOC%\src\style.css"                "%EXE_DOC%\src\style.css"                >nul && echo   OK  src\style.css
copy /y "%SRC_DOC%\src\font-dialog.html"         "%EXE_DOC%\src\font-dialog.html"         >nul && echo   OK  src\font-dialog.html
copy /y "%SRC_DOC%\src\text-effects-dialog.html" "%EXE_DOC%\src\text-effects-dialog.html" >nul && echo   OK  src\text-effects-dialog.html

if exist "%SRC_DOC%\assets" (
    xcopy /y /e /i /q "%SRC_DOC%\assets" "%EXE_DOC%\assets" >nul && echo   OK  assets\
)

echo.
echo ------------------------------------------
echo  Syncing JainSheet...
echo ------------------------------------------

copy /y "%SRC_SHT%\main.js"      "%EXE_SHT%\main.js"      >nul && echo   OK  main.js
copy /y "%SRC_SHT%\preload.js"   "%EXE_SHT%\preload.js"   >nul && echo   OK  preload.js
copy /y "%SRC_SHT%\renderer.js"  "%EXE_SHT%\renderer.js"  >nul && echo   OK  renderer.js
copy /y "%SRC_SHT%\index.html"   "%EXE_SHT%\index.html"   >nul && echo   OK  index.html
copy /y "%SRC_SHT%\package.json" "%EXE_SHT%\package.json" >nul && echo   OK  package.json

if exist "%SRC_SHT%\icon.ico" (
    copy /y "%SRC_SHT%\icon.ico" "%EXE_SHT%\icon.ico" >nul && echo   OK  icon.ico
)

echo.
echo =============================================
echo  Sync complete! Both apps updated.
echo =============================================
echo.
pause
