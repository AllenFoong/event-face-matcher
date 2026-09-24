@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" -u "scripts\serve.py" --no-tunnel
echo.
pause
