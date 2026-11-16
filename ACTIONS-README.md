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

签到跑完（无论成功失败）自动发一封积分报告邮件，收件人 `3766308071@qq.com` + `525177186@qq.com`，发件 `laixinqb@foxmail.com`。

内容包含：
- 当前可用积分 / 累计积分 / 会员等级与进度
- 本次运行增减（用运行前后快照对比）
- 距「中国石化礼品卡 500 元（96,530 分）」还差多少分、完成度百分比、进度条
- 按本次增量估算还需几天

实现：`scripts/notify/mail-report.mjs`，零依赖（手写 SMTP over TLS，只用 Node 内置模块），不额外装包。

流程：
1. `capture` —— 签到前读一次积分存 `.points-before.json`
2. `report` —— 签到后读积分、算差值、发信

手动本地测：
```powershell
$env:MAIL_AUTH="amirmjckxtfscdbg"; node scripts\notify\mail-report.mjs dry    # 只看正文不发
$env:MAIL_AUTH="amirmjckxtfscdbg"; node scripts\notify\mail-report.mjs send   # 真发
```

Secrets：`MAIL_FROM` / `MAIL_AUTH` / `MAIL_TO`
