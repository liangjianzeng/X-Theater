@echo off
rem ==== 8767 only entry (all sessions/agents share this; never run with THEATER_VAR override) ====
rem data dir: default var/ (merged A-line + theater-line episodes)
rem NOTE: keep this file ASCII-only -- cmd.exe parses .cmd in ANSI codepage; UTF-8 Chinese comments break line parsing.
cd /d E:\Work\X-Theater
set PORT=8767
set THEATER_COMFY=1
set THEATER_COMFY_INPUT=E:/ComfyUI/input
set THEATER_MUSIC_URL=http://127.0.0.1:8190
set THEATER_TTS_URL=http://127.0.0.1:9880
set THEATER_COMPOSE_REAL=1
set THEATER_COMFY_SPARK=1
set THEATER_COMFY_SPARK_URL=http://100.81.83.59:8188
rem llm-gw: local llama-server (E:\MyLLM\8090_huihui35b_q4k_cpu19.bat); empty = rules-mode fallback
set THEATER_LLM_URL=http://127.0.0.1:8090
set THEATER_LLM_MODEL=Huihui35B:vision
set THEATER_LLM_BAT=E:/MyLLM/8090_huihui35b_q4k_cpu19.bat
node src/server/index.js
