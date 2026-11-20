#!/usr/bin/env bash
# X-Theater Spark ComfyUI 幂等启动脚本（H3 线）
# 用法: bash start_comfyui.sh   （已在跑则直接退出）
set -u
PORT=8188
BASE=/home/jianzengliang/ComfyUI
LOG=$BASE/comfyui-8188.log
PID=$BASE/comfyui-8188.pid

if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "comfyui already running pid=$(cat "$PID")"
  exit 0
fi
# 端口被别的进程占用则报错退出（绝不杀别人进程）
if ss -tln | grep -q ":$PORT "; then
  echo "port $PORT occupied by unknown process; abort (check manually)"
  exit 1
fi

cd "$BASE"
setsid nohup "$BASE/venv/bin/python" main.py --port "$PORT" --listen 0.0.0.0 >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PID"
echo "started pid=$(cat "$PID") log=$LOG"
