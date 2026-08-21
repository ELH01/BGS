@echo off
REM Double-click this file to start the platform (Windows).
REM
REM Runs from wherever the project folder lives, so the folder can be moved or
REM renamed without breaking the launcher.
cd /d "%~dp0"
node scripts\launch.mjs
if errorlevel 1 pause
