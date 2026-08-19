@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org then run setup.cmd again.
  call :maybe_pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo npm install failed.
    call :maybe_pause
    exit /b 1
  )
)

echo Building skill-graft...
call npm.cmd run build
if errorlevel 1 (
  echo Build failed.
  call :maybe_pause
  exit /b 1
)

node dist\control\cli.js setup
set "SG_EXIT=%ERRORLEVEL%"
if not "%SG_EXIT%"=="0" (
  echo.
  echo Setup failed.
  call :maybe_pause
  exit /b %SG_EXIT%
)

echo.
call :maybe_pause
exit /b 0

:maybe_pause
echo %CMDCMDLINE% | findstr /i /c:" /c " >nul
if not errorlevel 1 pause
exit /b 0
