@echo off
chcp 65001 >nul
title 團隊中樞
rem The team chat hub on http://localhost:8300, restarted when it stops.
rem The password for this run is shown below. Close this window, or press Ctrl+C, to stop it.
cd /d "%~dp0"
if not exist node_modules (
  echo 第一次啟動：安裝套件中…
  call npm install --no-audit --no-fund
)
set OPEN=
:loop
node --use-system-ca --env-file-if-exists=.env server.js %* %OPEN%
set CODE=%ERRORLEVEL%
rem 0: stopped on purpose; 3: the hub is already open elsewhere.
if "%CODE%"=="0" goto end
if "%CODE%"=="3" goto end
echo [%date% %time%] 團隊中樞停了（代碼 %CODE%），3 秒後自動重開（密碼會換新的）。錯誤紀錄在 data\crash.log
timeout /t 3 /nobreak >nul
set OPEN=--no-open
goto loop
:end
echo 團隊中樞已關閉。
pause
