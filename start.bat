@echo off
setlocal
cd /d "%~dp0"
if not exist "gods-eye-view\node_modules" (
  echo [X] gods-eye-view is not installed yet. Run setup.bat first.
  pause & exit /b 1
)
echo [1/3] Starting God's Eye View server on http://localhost:4173 ...
start "Gods Eye View server" /d "%~dp0gods-eye-view" cmd /k npm run dev
echo [2/3] Starting World Eye GUI server on http://localhost:8790 ...
start "World Eye GUI server" /d "%~dp0world-eye" cmd /k node server.mjs
echo [3/3] Opening browser...
timeout /t 8 /nobreak >nul
start "" http://localhost:8790
echo.
echo Two server windows are running. Close them to stop.
timeout /t 5 >nul
