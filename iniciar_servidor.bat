@echo off
chcp 65001 >nul
title Controle de Guarita - Servidor
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nao encontrado. Instale o Node.js 22 ou superior. & pause & exit /b 1)
if not exist node_modules (echo Instalando dependencias... & call npm install --omit=dev)
:loop
node server.js
echo.
echo Servidor parou. Reiniciando em 3 segundos... (feche a janela para encerrar)
timeout /t 3 >nul
goto loop
