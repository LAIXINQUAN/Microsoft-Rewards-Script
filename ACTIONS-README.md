# Microsoft Rewards 自动签到（GitHub Actions 版）

基于 [chiihero/Microsoft-Rewards-Script](https://github.com/chiihero/Microsoft-Rewards-Script)（V4-china 中文本地化版，上游 TheNetsky）。

## 结构

- `.github/workflows/rewards-daily.yml` —— 每日北京时间 06:20 自动跑（UTC 22:20），也可手动触发
- `config.json` —— 运行配置（不进 git，由 Secret 注入）
- `.env` —— 账号配置（不进 git，由 Secret 注入）
- `sessions/sessions.db` —— 浏览器会话 + 指纹（不进 git，首次由 Secret 注入，之后走 Actions 缓存滚动）

## 需要的 Secrets

| 名称 | 说明 |
|---|---|
| `ACCOUNT_1_EMAIL` | 微软账号邮箱 |
| `ACCOUNT_1_PASSWORD` | 密码（无密码登录可留空） |
| `CONFIG_JSON` | 完整 config.json 内容 |
| `SESSIONS_DB_B64` | `gzip -9 sessions/sessions.db | base64 -w0` 的结果，**只在第一次运行需要** |

## 会话如何续期

1. 第一次运行：从 `SESSIONS_DB_B64` 解出一份 sessions.db
2. 跑完：`actions/cache/save` 存成 `sessions-<run_id>`（缓存不覆盖，每次新 key）
3. 下次运行：`restore-keys: sessions-` 前缀匹配，自动取最新那份
4. 如果某天 cookie 全过期 → 改本地重新登录，更新 `SESSIONS_DB_B64` Secret 即可

> GitHub 缓存 7 天没被访问就会回收，但每天跑一次不会触发回收。

## 本地重新登录并导出 sessions.db

```powershell
cd ms-rewards
node login-live.js          # 弹出窗口，登录完自动保存 sessions/storageState-login.json
node mksession.js           # 生成 sessions/sessions.db + sessions.db.b64
node gz.js                  # 生成 sessions.db.gz.b64（这个喂给 Secret）
```

## 手动触发

```powershell
gh workflow run rewards-daily
gh run watch
```

## 说明

- 私有仓库 Actions 每月 2000 分钟免费额度，每天一次约 45 分钟，够用（约 1350 分钟/月）
- 公开仓库无限额度
- 定时任务在仓库 60 天无提交后会被 GitHub 自动暂停，需要手动启用或加保活提交

---

## 实测记录（2026-11-16）

- 账号：3766308071@qq.com（CN / zh-CN）
- 登录：本机 Chrome 可见窗口手动登录 → CDP 抓 cookie → 生成 sessions.db（desktop + mobile 两行，同一份 cookie）
- 本地验证：`node dist/index.js` 跑通，积分 10159 → 10424（+265），连续保护已启用、剩余 10 天
- Actions 首次运行：workflow 步骤 1-10 全部通过；会话注入、config 注入、.env 注入、npm ci、Chromium 安装、编译均成功

## 已知限制（实测）

1. `GET_REWARD-SESSION` 走的是 API/bootstrap 模式，主接口 `Dashboard data missing from API response` 时会 fallback 到 Bing flyout，日志里有 WARN 但不影响拿分
2. App 推广类任务（Sapphire_AppNewBonus_*）多数返回 0 分，属账号/地区限制，不是脚本问题
3. `ZHstar_Rewards_DailyGlobalOffer_Evergreen_VerB_Locked_level2` 期望 100 实际 0，同上

## 排障

- Actions 报 `既没有缓存也没有 SESSIONS_DB_B64`：重新本地登录导出 sessions.db 更新 Secret
- Actions 报 `Login failed`：cookie 过期，本地重登
- 想改搜索条数：改 config.json → 更新 `CONFIG_JSON` Secret

---

## 邮件日报

签到跑完（无论成功失败）自动发积分报告，收件人 `3766308071@qq.com`，发件 `laixinqb@foxmail.com`。

内容：
- 当前可用积分、累计积分、会员等级与等级进度、连续签到天数（能取到才显示）
- 本次运行增量 `+N 分（原余额 → 现余额）`
- 距「中国石化礼品卡 500 元（96,530 分）」还差多少、完成度百分比、进度条、按当日增量估算还需几天

积分取值优先级：
1. **签到日志**（`rewards-run.log`，由 workflow 的 `tee` 生成）——解析 `MAIN [RUN-END]` / `MAIN [ACCOUNT-END]` 行的 `获得积分=|原余额=|现余额=`，并抓 `连续计数=N`。最可靠，不依赖 cookie。
2. **Rewards API**（sessions.db 里的 cookie 调 `getuserinfo`）——仅当日志缺失时兜底，用于补累计积分/等级。云端 IP 上这个接口常返回 401，属正常。

实现：`scripts/notify/mail-report.mjs`，零依赖（手写 SMTP over TLS + node:sqlite），不额外装包。

流程：`capture`（签到前 API 快照，失败不影响）→ 签到 `tee rewards-run.log` → `report`（解析日志 + 发信）。

本地测：
```powershell
$env:MAIL_AUTH="amirmjckxtfscdbg"; node scripts\notify\mail-report.mjs dry    # 只看正文
$env:MAIL_AUTH="amirmjckxtfscdbg"; node scripts\notify\mail-report.mjs send   # 真发
```

Secrets：`MAIL_FROM` / `MAIL_AUTH` / `MAIL_TO`

---

## 抗「高峰期任务被丢弃」（2026-11-16）

GitHub 的 `schedule` 触发器在整点/高负载时段会**直接丢弃**本次触发（不会补跑、不会报错，run 列表里根本没有这一次）。单个 cron 每天只有一次机会，赶上就是整天没签到。

本仓库做了四层保险：

### 1. 多时段备用 cron

`rewards-daily.yml` 里有 5 个 cron，北京时间为 06:20 / 07:05 / 08:10 / 10:20 / 13:40（全部错开整点）：

| cron (UTC) | 北京时间 |
|---|---|
| `20 22 * * *` | 06:20（主） |
| `5 23 * * *` | 07:05 |
| `10 0 * * *` | 08:10 |
| `20 2 * * *` | 10:20 |
| `40 5 * * *` | 13:40 |

只要 5 次里有 1 次被调度到，当天就算拿到分。

### 2. 幂等闸（gate job）

多 cron 的副作用是可能跑多遍。所以 `run` job 前加了一个 `gate` job：

1. 算北京日期 `D`
2. `actions/cache/restore` 找 key = `rewards-done-<D>`
3. 命中 → `should_run=false`，`run` job 被 `if` 跳过（耗时十几秒，不浪费额度）
4. 未命中 → 正常执行

签到 job 只有 `success()` 时才 `actions/cache/save` 那个标记 key，所以**失败的日子后面的备用时段还会重试**，成功当天则只跑一次。

### 3. concurrency 排队而不是并行

`cancel-in-progress: false`，所以备用时段撞上主时段在跑时会排队；等前一个跑完，它自己再查标记，看到已完成就跳过。不会出现两个 Chromium 同时抢同一个账号。

### 4. 保活（防止 Actions 被整体停用）

GitHub 在仓库连续 60 天无提交后会自动停用 `schedule`。`keepalive.yml` 每月 3 个非整点时段（1 号 03:17、11 号 07:43、21 号 11:26 UTC）各跑一次提交 `.github/KEEPALIVE.md`，任意一次成功即可。

### 手动兜底

`workflow_dispatch` 带 `force=true` 会忽略当日标记强制执行：

```powershell
gh workflow run rewards-daily --repo LAIXINQUAN/Microsoft-Rewards-Script --ref V4-china -f force=true
gh run watch
```

### 仓库外兜底（可选，做了一层就没配）

上面的方案全在 GitHub 内部，极端情况（整个 Actions 区域性故障、免费额度用尽）仍会漏。想再加一层外部定时器：

1. 建一个 fine-grained PAT，只给目标仓库 `Actions: write` 权限
2. 到 [cron-job.org](https://cron-job.org) 建任务，每 30 分钟 POST 一次：

```
POST https://api.github.com/repos/LAIXINQUAN/Microsoft-Rewards-Script/actions/workflows/rewards-daily.yml/dispatches
Authorization: Bearer <PAT>
Accept: application/vnd.github+json
{"ref":"V4-china","inputs":{"force":"false"}}
```

因为带了幂等闸，外部定时器每 30 分钟无脑打一次是安全的——只有当天没成功时才真正开跑。
