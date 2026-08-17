@echo off
REM Doppelklick-Starter fuer ProCurve Cockpit.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
