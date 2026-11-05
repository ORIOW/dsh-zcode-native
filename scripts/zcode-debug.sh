#!/bin/bash
# 带 CDP 调试端口启动 ZCode（macOS）
#
# 为什么不能只写 open -a ZCode --args --remote-debugging-port=9222 ：
#   ZCode 是 Electron 单实例应用。若已有实例在跑，`open` 只会把那个窗口提到前台，
#   --args 被静默丢弃，端口不会开。3.17.1 起更是直接被单实例锁 + argv 解析器
#   拒掉（bad option）。必须先把旧实例完全退出，再由终端带参数启动。
#
# 用法：
#   ./zcode-debug.sh            # 默认端口 9222
#   ./zcode-debug.sh 9444       # 自定义端口

set -u

PORT="${1:-9222}"
APP_BIN="/Applications/ZCode.app/Contents/MacOS/ZCode"
LOG="/tmp/zcode-cdp-${PORT}.log"

if [ ! -x "$APP_BIN" ]; then
  echo "找不到 ZCode 可执行文件：$APP_BIN" >&2
  exit 1
fi

# 1. 端口已被占用 → 说明目标实例已在跑，直接报告，不做任何破坏性操作
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已在监听，ZCode 已经带调试端口在跑："
  curl -s --max-time 5 "http://127.0.0.1:$PORT/json/version" | head -3
  exit 0
fi

# 2. 退掉已有实例（单实例锁会吞掉 --args）
if pgrep -f "$APP_BIN" >/dev/null 2>&1; then
  echo "检测到 ZCode 已在运行但没开调试端口，先退出旧实例…"
  osascript -e 'tell application "ZCode" to quit' 2>/dev/null || true
  sleep 2
  pgrep -f "$APP_BIN" >/dev/null 2>&1 && pkill -f "$APP_BIN" && sleep 1
fi

# 3. 启动
echo "启动 ZCode，调试端口 ${PORT}，日志 ${LOG}"
nohup "$APP_BIN" --remote-debugging-port="$PORT" >"$LOG" 2>&1 &

# 4. 等待并验证
for _ in $(seq 1 20); do
  sleep 1
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "OK — CDP 已就绪："
    curl -s --max-time 5 "http://127.0.0.1:$PORT/json/version" | head -4
    exit 0
  fi
done

echo "启动后 20 秒内端口 $PORT 仍不可达，看日志：$LOG" >&2
tail -20 "$LOG" >&2
exit 1
