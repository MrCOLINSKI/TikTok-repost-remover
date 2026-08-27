@echo off
REM Double-click me to run the app so you can open it on your iPhone.
REM Same app as run.bat, but served on your home network with an access code.
cd /d "%~dp0"

if not exist ".venv" (
  echo Creating virtualenv...
  python -m venv .venv || goto :fail
  ".venv\Scripts\python.exe" -m pip install --upgrade pip || goto :fail
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail
  ".venv\Scripts\python.exe" -m playwright install chromium || goto :fail
)

".venv\Scripts\python.exe" app.py --phone
goto :eof

:fail
echo.
echo Setup failed. Make sure Python 3.11 is installed and on PATH.
pause
