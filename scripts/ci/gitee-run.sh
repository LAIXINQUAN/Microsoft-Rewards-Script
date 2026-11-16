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
# ===================================================================
set -euo pipefail

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
  cd "$(dirname "$0")/../.."
fi

echo "node $(node --version) | now $(date '+%F %T %Z') | pwd $(pwd)"
echo "runner 版本 v4-donekey（同步日志 + 硬超时 + 全局保活 + RUNS_PER_PAGE=20 + done key 判据 + 时间窗）"
echo "token 长度 ${#GH_TOKEN}（内容不打印）"

if [ ! -f scripts/ci/dispatch-gitee.cjs ]; then
  echo "!! 找不到 scripts/ci/dispatch-gitee.cjs"
  exit 1
fi

node scripts/ci/dispatch-gitee.cjs "$@"
RC=$?
echo "=== exit=$RC ==="
exit $RC
