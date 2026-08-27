@echo off
REM Double-click me to start the TikTok Repost Remover.
cd /d "%~dp0"

if not exist ".venv" (
  echo Creating virtualenv...
  python -m venv .venv || goto :fail
  ".venv\Scripts\python.exe" -m pip install --upgrade pip || goto :fail
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail
  ".venv\Scripts\python.exe" -m playwright install chromium || goto :fail
)

".venv\Scripts\python.exe" app.py
goto :eof

:fail
echo.
echo Setup failed. Make sure Python 3.11 is installed and on PATH.
pause
