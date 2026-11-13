@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules\electron (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 pause
endlocal
