#!/usr/bin/env bash
# ===================================================================
# Gitee Go 构建入口（被 .workflow/rewards-dispatcher.yml 调用）
#   用法：bash scripts/ci/gitee-run.sh <GH_TOKEN> [传给 dispatch-gitee.cjs 的参数]
#   例：  bash scripts/ci/gitee-run.sh "$TOKEN"          # 正常跑
#         bash scripts/ci/gitee-run.sh "$TOKEN" --dry    # 只判断不触发
#
# 为什么要把 shell 逻辑放这里而不是写在流水线 yml 的 commands 里：
#   Gitee Go 的 commands 是「命令列表」，多行 if/export 写进列表很容易被逐条拆开执行，
#   放进 .sh 里由 bash 一次解释，行为确定、本地也能直接跑。
#
# 2026-11-20 修缮：原来用 set -euo pipefail，node 非 0 时脚本被 set -e 直接中断，
#   后面 echo "=== exit=$RC ===" 是死代码，Gitee 日志只剩一句笼统的 Failure（exit 255），
#   看不到到底是哪个目标失败了。改成只开 -uo pipefail，node 的退出码自己接住再回显。
# ===================================================================
set -uo pipefail

export TZ="Asia/Shanghai"

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "!! 缺少 GH_TOKEN 参数：流水线里应写成 bash scripts/ci/gitee-run.sh \"<token>\""
  exit 1
fi
export GH_TOKEN="$TOKEN"
shift || true

# 构建环境一般在仓库根目录；如果不在就往上找两级（scripts/ci -> 仓库根）
if [ ! -d "scripts/ci" ]; then
  cd "$(dirname "$0")/../.." || exit 1
fi

echo "node $(node --version) | now $(date '+%F %T %Z') | pwd $(pwd)"
echo "runner 版本 v5-exitrc（同步日志 + 硬超时 + 全局保活 + done key 判据 + 时间窗 + 退出码可见）"
echo "token 长度 ${#GH_TOKEN}（内容不打印）"

if [ ! -f scripts/ci/dispatch-gitee.cjs ]; then
  echo "!! 找不到 scripts/ci/dispatch-gitee.cjs"
  exit 1
fi

node scripts/ci/dispatch-gitee.cjs "$@"
RC=$?
echo "=== exit=$RC ==="
if [ "$RC" -ne 0 ]; then
  echo "!! 本次调度失败（exit=$RC）。退出码含义：1=有目标报错（Actions 被禁用/触发被拒），2=--only 没匹配到目标。"
  echo "!! 常见原因：fork 仓库的 Actions 被 GitHub 关掉了 —— 去 https://github.com/LAIXINQUAN/Microsoft-Rewards-Script/actions 点绿色按钮重新启用。"
fi
exit $RC
