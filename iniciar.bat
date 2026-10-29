@echo off
rem Abre o Win Saber (compila na primeira vez ou quando nao houver build).
cd /d "%~dp0"
if not exist "node_modules" (
    echo Instalando dependencias...
    call npm install || goto :erro
)
if not exist "dist\index.html" (
    echo Compilando...
    call npm run build || goto :erro
)
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:erro
echo Falha ao preparar o jogo.
pause
