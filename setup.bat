@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   World Eye setup
echo ============================================

where git >nul 2>nul
if errorlevel 1 (
  echo [X] git not found. Install Git for Windows: https://git-scm.com/download/win
  pause & exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Install Node.js 24 LTS: https://nodejs.org
  pause & exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p process.versions.node') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo [X] Node.js major version %NODE_MAJOR% found. gods-eye-view needs Node 24.14 or later.
  echo     Please install Node.js 24 LTS from https://nodejs.org and run setup.bat again.
  pause & exit /b 1
)

if exist "gods-eye-view\.git" (
  echo [i] gods-eye-view already exists - updating with git pull
  git -C gods-eye-view pull --ff-only
) else (
  echo [i] git clone https://github.com/bilawalsidhu/gods-eye-view.git
  git clone https://github.com/bilawalsidhu/gods-eye-view.git
)
if errorlevel 1 (
  echo [X] git step failed.
  pause & exit /b 1
)

pushd gods-eye-view
echo [i] npm ci - installing gods-eye-view packages, this takes a few minutes...
call npm ci
if errorlevel 1 (
  popd
  echo [X] npm ci failed.
  pause & exit /b 1
)
call npm run doctor
popd

echo.
echo ============================================
echo   AI CLI engines
echo ============================================
for %%c in (agy claude codex) do (
  where %%c >nul 2>nul && (echo [OK] %%c) || (echo [--] %%c not installed - see README.md)
)
echo.
echo Setup finished. Double-click start.bat to launch.
pause
