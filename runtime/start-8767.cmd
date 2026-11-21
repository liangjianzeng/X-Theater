@echo off
rem ==== 8767 唯一启动方式（所有会话/智能体共用，禁止另带 THEATER_VAR 启动）====
rem 数据目录：默认 var/（已合并 A 线与剧场线全部剧集）
cd /d E:\Work\X-Theater
set PORT=8767
set THEATER_COMFY=1
set THEATER_COMFY_INPUT=E:/ComfyUI/input
set THEATER_MUSIC_URL=http://127.0.0.1:8190
set THEATER_TTS_URL=http://127.0.0.1:9880
set THEATER_COMPOSE_REAL=1
node src/server/index.js
