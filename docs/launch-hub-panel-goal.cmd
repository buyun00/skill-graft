@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$exe='C:\Users\win11\.grok\bin\grok.exe'; $p='Read E:\ozdqp-skill-hub\docs\hub-panel-goal-prompt.md completely, then execute it. /goal Build the Skill Hub control panel using E:\graft-glass-ui. Homepage must have both attention and empty states. Frontend only talks to http://127.0.0.1:18765. Do not import src/core. Missing components go in the library. Verify in the browser.'; Start-Process -FilePath $exe -WorkingDirectory 'E:\ozdqp-skill-hub' -ArgumentList @('-m','grok-4.6','--effort','xhigh','--cwd','E:\ozdqp-skill-hub','--always-approve','--no-plan','--fullscreen',$p)"
