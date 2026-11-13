@echo off
rem Publica no GitHub publico (wesleiad/Controle-Guarita) para o servidor da guarita se atualizar sozinho.
cd /d "%~dp0"
node publicar-github.js %*
pause
