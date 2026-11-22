@echo off
rem ==== detached launcher: same env as canonical entry, log to file, for agent/tool shells ====
rem NOTE: keep this file ASCII-only -- cmd.exe parses .cmd in ANSI codepage.
cd /d E:\Work\X-Theater
call runtime\start-8767.cmd > var\log-server.log 2>&1
