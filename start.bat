@echo off
REM Double-click launcher for ProCurve Cockpit.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
