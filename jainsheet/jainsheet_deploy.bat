@echo off
if "%1"=="RELAUNCHED" goto :MAIN
start "JainSheet Deploy" /WAIT cmd /k "%~f0" RELAUNCHED
exit

:MAIN
cd /d D:\JainSheet
git config --global --add safe.directory "*"
git config --global user.name "NuclearCentre"
git config --global user.email "admin@jainsheet.com"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\JainSheet\jainsheet_deploy.ps1"
