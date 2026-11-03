#!/bin/zsh
# 双击即可启动龙虾脑 Demo（服务端 + 电脑端助手）
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "未找到 Node.js，请先安装：https://nodejs.org （或 brew install node）"; read; exit 1
fi
[ -d node_modules ] || npm install --no-fund --no-audit
mkdir -p .runtime
# 检查辅助功能权限（创建会议、读取会议号需要）
if ! osascript -e 'tell application "System Events" to get name of first process' >/dev/null 2>&1; then
  echo "⚠️  终端尚未获得「辅助功能」权限：创建腾讯会议、读取会议号会受影响。"
  echo "   请到 系统设置 → 隐私与安全性 → 辅助功能，打开「终端」，然后重新启动本程序。"
  echo
fi
( sleep 2; open "http://localhost:${PORT:-4320}/admin" ) &
node src/launch.mjs 2>&1 | tee .runtime/run.log
