@echo off
:: Maton Login Helper - Start with logging
:: Logs: C:\Users\X\maton-login-helper\app.log
::
:: Management commands (run in PowerShell):
::   Stop:     Stop-ScheduledTask -TaskName "MatonLoginHelper"
::   Disable:  Disable-ScheduledTask -TaskName "MatonLoginHelper"
::   Enable:   Enable-ScheduledTask -TaskName "MatonLoginHelper"
::   Delete:   Unregister-ScheduledTask -TaskName "MatonLoginHelper"
::   Status:   Get-ScheduledTask -TaskName "MatonLoginHelper"
cd /d "C:\Users\X\maton-login-helper"
C:\nvm4w\nodejs\node.exe server.js >> "C:\Users\X\maton-login-helper\app.log" 2>&1
