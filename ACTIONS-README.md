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

### 本机兜底调度器（已配好）

上面几条全在 GitHub 内部，极端情况（Actions 区域性故障、额度用尽、schedule 长时间抽风）仍会整天漏掉。所以在本机挂了一个每 30 分钟跑一次的看守脚本，主动去 **查** 今天的真实执行结果，没成功才 dispatch。

**脚本**：`scripts/ci/ensure-daily-run.mjs`（零依赖，Node 18+ built-in fetch）

```
node scripts\ci\ensure-daily-run.mjs            # 正常跑：查 + 必要时 dispatch
node scripts\ci\ensure-daily-run.mjs --dry      # 只看判断结果，不触发
node scripts\ci\ensure-daily-run.mjs --force    # 忽略今日标记，强制 dispatch
node scripts\ci\ensure-daily-run.mjs --only=kg  # 只处理 kgcheckin
```

**监的两个目标**（写在文件顶部的 `TARGETS` 数组里）：

| 标签 | 仓库 | workflow id | ref |
|---|---|---|---|
| rewards-daily | LAIXINQUAN/Microsoft-Rewards-Script | 420202401 | V4-china |
| kgcheckin-签到 | LAIXINQUAN/kgcheckin | 372755970 | main |

**判定逻辑（关键：不能只看 run 的 conclusion）**

gate 跳过的 run 也是 `conclusion=success`，直接判断会误以为今天已经签到过。所以脚本会下钻到 job 级别：

1. 拉该 workflow 当天（按北京日期）的 runs
2. 有 `in_progress` / `queued` 的 → 正在跑，什么都不做
3. 对最多前 3 个 `success` 的 run 逐个查 `/actions/runs/<id>/jobs`，看有没有名字匹配 `执行签到|签到|run` 且 `conclusion=success` 的 job
4. 全都不满足 → `POST /actions/workflows/<id>/dispatches`

**token**：优先 `GITHUB_TOKEN` / `GH_TOKEN` 环境变量，否则调 `gh auth token`（Windows 下先试 `C:\Program Files\GitHub CLI\gh.exe` 绝对路径，再试 PATH 里的 `gh`——计划任务里的 PATH 很短，绝对路径这步不能省）。

**日志**：`%USERPROFILE%\.rewards-dispatcher\log.txt`，超过 256 KB 自动清空。

#### 挂成 Windows 计划任务

```
cd ms-rewards
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\register-task.ps1
```

注册出来的任务：

- 名字：`RewardsDailyDispatcher`
- 动作：`node <repo>\scripts\ci\ensure-daily-run.mjs`
- 触发：每 30 分钟一次，持续 3650 天，`-StartWhenAvailable`（睡过头/关机错过会补跑）
- 设置：允许电池运行、不因切电池停止、多实例忽略新、单次最长 15 分钟

常用操作：

```
Start-ScheduledTask -TaskName RewardsDailyDispatcher      # 立即试跑一次
Get-ScheduledTaskInfo -TaskName RewardsDailyDispatcher    # 看上次结果/下次时间
Get-Content (Join-Path $env:USERPROFILE '.rewards-dispatcher\log.txt') -Tail 20 -Encoding UTF8   # 看日志
powershell -File scripts\ci\unregister-task.ps1         # 撤销
```

> 计划任务按**当前用户**注册，只在登录状态下运行。电脑长期关机的话它也不会跑——那种情况下靠 GitHub 里的 5 个 cron 就够。

#### 为什么外部无脑打是安全的

dispatch 触发的 run 一样要走 gate：当天已经成功过就直接 `should_run=false` 跳过执行 job，耗时十几秒。所以这个看守脚本每 30 分钟打一次也不会重复签到、不烧额度。

副作用只有一种：如果某天早上 6:20 主时段被丢弃、7:05 也丢了，看守脚本会在下一次检查时补一次 dispatch，签到时间会比平时晚——这正是想要的行为。

---

## 国内第三方平台托管兜底（可选）

本机计划任务只在电脑开机时有效。要 7×24 兜底，可以再挂一层国内云函数——国内访问 ~api.github.com~ 实测直连 60ms，不需要代理。

代码：~scripts/ci/cloud-function-cn.js~（一份代码同时兼容腾讯云 SCF、腾讯云 CloudBase、阿里云 FC、华为云 FunctionGraph、百度 CFC、火山 veFaaS），已打包成可直接上传的 ~scripts/ci/rewards-dispatcher-cn.zip~（内含 ~index.js~ + ~package.json~，2.8KB）。

### 平台对比（免费额度以官方为准）

| 平台 | 免费额度 | 定时最小粒度 | 要实名 | 要信用卡 | 备注 |
|---|---|---|---|---|---|
| 腾讯云 SCF | 每月 100 万 GBs + 400 万次调用 | 1 分钟（7 段 cron） | 是 | 否 | **最推荐**，控制台直接传 zip |
| 腾讯云 CloudBase 云开发 | 有免费额度 | 1 分钟 | 是 | 否 | 和 SCF 同一套代码，走 Web 控制台更简单 |
| 阿里云函数计算 FC | 每月 40 万 CU·秒 | 1 分钟（6 段 cron，UTC） | 是 | 否 | 需装 ~fun~ CLI 或控制台传 zip |
| 华为云 FunctionGraph | 每月 100 万次调用 | 1 分钟 | 是 | 否 | 出口 IP 稳定，国内访问 GitHub 也通 |
| 百度智能云 CFC | 每月 10 万次调用 | 1 分钟 | 是 | 否 | 够用 |
| 火山引擎 veFaaS | 有免费额度 | 1 分钟 | 是 | 否 | 够用 |
| 腾讯云函数 + API 网关 | 同上 + 网关免费额度 | - | 是 | 否 | 想暴露 HTTP 入口（给监控打）才需要 |

### 腾讯云 SCF 部署步骤（15 分钟）

1. 打开 https://console.cloud.tencent.com/scf → 函数服务 → 新建
2. 创建方式选 **从头开始**，函数类型 **事件函数**
3. 运行环境选 **Node.js 20**（或 18/22，都行）
4. 函数代码 → 提交方法选 **上传 ZIP 包** → 选本仓库的 ~scripts/ci/rewards-dispatcher-cn.zip~
5. 执行角色：选「使用默认角色」即可（不需要访问其他腾讯云资源）
6. 环境变量 → 新增 ~GH_TOKEN~ = 你的 fine-grained PAT（权限：**Actions: Read and write**，仓库限 ~LAIXINQUAN~ 两个仓库即可）
7. 超时时间改成 **60 秒**（默认 3 秒不够拉 60 条 run 列表）
8. 内存保持默认 128 MB
9. 触发器 → 创建触发器 → 类型 **定时触发器** → Cron：@@0 */30 * * * * *@@
10. 保存 → 在控制台「函数管理 → 函数代码 → 测试」点一次运行，看返回的 ~message~ 里两条目标是不是「今天已成功」

### 阿里云 FC 部署

1. 控制台 https://fcnext.console.aliyun.com → 服务与函数 → 创建函数
2. 类型选 **事件函数**，运行环境 **Node.js 18**
3. 代码上传同一个 zip，入口函数写 ~index.handler~
4. 环境变量 ~GH_TOKEN~ 同上
5. 函数配置 → 超时时间 60 秒
6. 触发器 → **定时触发器** → Cron 表达式（UTC 6 段）：@@0,30 * * * *@@
7. 内存 128 MB

### 代码里的三个共同点（为什么一份代码能到处跑）

1. **不用 global fetch**：云函数 Node 运行时可能没有，全部走内置 ~node:https~
2. **自己算北京日期**：云函数地域时区不一定是 +8，~beijingDate()~ 直接 ~+8h~ 再取日期
3. **导出三个 handler 名**：~main_handler~（SCF）/ ~main~（CloudBase）/ ~handler~（阿里云、华为云、百度、火山），配合 ~package.json~ 的 @@"type":"commonjs"@@ 直接跑

### 判定逻辑和本机版一致

不会因为 gate 跳过就误判「今天已完成」：对每个 ~success~ 的 run 都会下钻到 ~/actions/runs/<id>/jobs~ 确认存在 ~conclusion=success~ 且名字匹配 ~执行签到|签到|run~ 的 job。

### 实测记录

- 本地用真实 token 跑 ~runAll({},{})~ → 输出 @@[2026-11-16] rewards-daily: 今天已成功（run 43895129200），无需触发 | kgcheckin-签到: 今天已成功（run 43895562060），无需触发@@
- 用假 token 跑 → 正确捕获 HTTP 401 并写进返回值，不崩
- 国内直连 ~https://api.github.com/rate_limit~：558ms / 59ms / 59ms（三次）
- 已随仓库推送：~scripts/ci/cloud-function-cn.js~（5603 B）、~scripts/ci/rewards-dispatcher-cn.zip~（2855 B）

---

## 不用实名的中国平台（含实测可用度）

问题背景：腾讯云 SCF、阿里云 FC、华为云 FunctionGraph、百度 CFC、火山 veFaaS 都要**实名认证**（上传身份证/营业执照）。下面这些能跑定时任务、又不需要上传身份证。

### 首选：CNB（cnb.cool，腾讯云原生构建）

- **登录**：微信扫码。不填身份证、不要信用卡。
- **免费额度**（官方定价页 https://docs.cnb.cool/zh/pricing.html）：云原生构建 **160 核时/月**（1 核 2G 折合 160 小时）、仓库存储 100 GiB、对象存储 100 GiB、AI Credits 500/月。本用途每 30 分钟一次、每次约 10 秒 → 每月约 **2.4 小时**，占免费额度 1.5%。
- **定时能力**（官方文档 https://docs.cnb.cool/zh/build/crontab.md）：
  - 配置放仓库根目录 **.cnb.yml**
  - 定时触发器写成 key：@@main:  {  "crontab: 30 5,17 * * *": ... }@@
  - **时区固定 Asia/Shanghai**，不用换算 UTC（比 GitHub 舒服）
  - **最小间隔 5 分钟**；低于 5 分钟（如 @@* * * * *@@）不允许提交
  - 同一分支可写多个 crontab key = 多个时段
  - 分支必须写**明确的单一分支名**，**不支持 glob**
  - 触发身份 = 「最后修改并推送该 crontab 配置的人」；此人被移出仓库则定时任务失败
  - 定时任务的 CNB_TOKEN 默认**只能访问当前仓库**，跨仓库需组织管理员开「允许定时任务跨仓操作」
- **⚠️ 必做开关**：fork / 导入的仓库**默认不执行「定时任务」事件**。必须进 仓库 → 设置 → 云原生构建 → 勾选「允许自动触发」；组织层还有「允许定时任务自动触发」总开关（默认开）。依据：https://docs.cnb.cool/zh/build/trigger-rule.md
- **已备好的文件**：仓库根目录 **.cnb.yml**（已推送，分支 V4-china）= node:20 镜像 + 每 30 分钟跑 ~scripts/ci/ensure-daily-run.mjs~。只需把 GH_TOKEN 换成真 token。
- **token 安全**：别明文提交。CNB 有「密钥仓库」，放个 envs.yml 写 GH_TOKEN，.cnb.yml 里改用 ~~imports: https://cnb.cool/<slug>/-/blob/main/envs.yml~~（env 与 imports 冲突时 env 优先）。

### 备选 1：Gitee Go（码云流水线）

- **实名**：注册只要邮箱/手机号，开流水线不上传身份证。
- **免费额度**（https://help.gitee.com/gitee-go/price）：单个代码仓库 **200 分钟**构建时长**永久**有效；个人/组织每月额外 **500 分钟**自动到账。本用途别 30 分钟一次，改每小时或一天几次。
- **定时触发**（https://help.gitee.com/gitee-go/pipeline/trigger）：
  ```yaml
  triggers:
    schedule:
      - cron: '0 0/30 * * * ?'
  ```
  - **目前只支持写一个 cron 表达式**，不支持多时段
  - **Quartz 风格**（秒在前，6~7 段；「日」与「星期」不能同时为 *，不用的写 ?）
- **落地方式**（https://help.gitee.com/gitee-go/quick-start）：图形视图或代码视图编排 → 保存后平台自动往仓库提交 yaml。模型 = 流水线 → 阶段 → 任务（一个任务 = 一个插件），跑 node 脚本选「Shell 脚本执行」。
- **已备好的文件**：~scripts/ci/gitee-go-pipeline.yml~（已推送）。⚠️ Gitee Go 的 YAML 插件结构各版本有出入，导入报错就改用图形视图点选。

### 备选 2：AtomGit / GitCode 流水线

- 语法几乎等于 GitHub Actions：放 **.gitcode/workflows/**（不是 .github/workflows），支持 @@on: schedule: - cron: '0 2 * * *'@@，也支持 workflow_dispatch。
- **卡点**：快速开始页明确写「前提条件：**申请获取代码化流水线内测名额**（内测名额有限，详情请咨询 AtomGit 客服）」。不能自助开通。
- 结论：能用但不可控，排最后。

### 明确不合适的

| 平台 | 为什么不行 |
| --- | --- |
| Vercel Hobby | cron 每天最多触发一次 |
| Zapier | 免费按月任务数，两天跑光 |
| Pipedream | 有每日调用上限 |
| Render / Railway / Fly | 定时任务基本在付费档 |
| Gitee Pages / 静态托管 | 只有静态文件，没有后台定时 |
| 阿里云云效 Flow | 组织功能需实名认证 |
| 华为云 / 百度 / 火山 函数计算 | 都要实名 |

### 一句话选型

**要现在落地 → CNB**（微信登录、不实名、160 核时/月、时区就是北京时间、.cnb.yml 已写好并推送）。
Gitee Go 当第二备份（500 分钟/月够用，但 cron 只能写一条）。
Cloudflare Worker / Google Apps Script 当境外备份（代码见上一章）。

### 本机实测（2026-11-16）

- 用真 token 跑 ~node scripts/ci/ensure-daily-run.mjs --dry~ → @@[rewards-daily] 今天已成功（run 43895129200），无需触发@@ / @@[kgcheckin-签到] 今天已成功（run 43895562060），无需触发@@，exit 0
- 国内直连 ~api.github.com~ 三次：558ms / 59ms / 59ms 全 200，不需要代理

---

## 「凌晨假成功」问题与四层防护（2026-11-17）

### 现象

备用时段第一次跑在**北京 00:10**，run 43904591418 的结果：

- 账面积分只 +33（10505 → 10538），而前一天 23:19 那趟是 **+313**（10159 → 10472）
- 日志里 `MAIN [SEARCH-MANAGER] 桌面端: skip (complete, 60/60)` —— 桌面搜索额度还是满的
- 结论：**微软 Rewards 的每日任务不是北京 00:00 重置**，00:10 跑到的只是前一天剩下的零头

危险在于它照样会写 `rewards-done-2026-11-17` 标记，于是当天 06:20 / 07:05 / 08:10 … 所有真正能拿满的时段全部被判「今天已完成」跳过，**白丢一整天积分**。

对照：全民K歌**确实**在北京 00:00 重置（00:10 那趟三个账号各领 8 次全部成功、日期写的是当天），所以 kg 侧不需要这道闸。

### 防护 1：workflow 里的时间窗（gate 新增步骤）

`rewards-daily.yml` 的 gate job 在「计算北京日期」之后加了一步「判断执行时间窗」：

```yaml
- name: 判断执行时间窗
  id: win
  run: |
    set -e
    H=$(TZ=Asia/Shanghai date +%H | sed "s/^0//")
    if [ -z "$H" ]; then H=0; fi
    if [ "$H" -lt 6 ]; then
      echo "open=false" >> "$GITHUB_OUTPUT"
      echo "::notice::现在是北京 ${H} 点，早于 06:00，微软每日任务通常还没重置，本次不执行"
    else
      echo "open=true" >> "$GITHUB_OUTPUT"
    fi
```

judge 步骤的分支顺序因此变成：**force → 时间窗 → 今日标记 → 执行**。

### 防护 2：增量不足就不写今日标记

原本只要签到步骤 success 就写标记，现在要求**本次获得积分 ≥ 100** 才写：

```bash
GAIN=$(grep -oE "获得积分=[0-9]+" rewards-run.log | tail -1 | grep -oE "[0-9]+$")
MIN_GAIN=100
if [ "$GAIN" -lt "$MIN_GAIN" ]; then
  echo "::warning::本次只拿到 $GAIN 分（阈值 $MIN_GAIN），疑似微软每日任务尚未重置，不写今日完成标记"
  exit 0
fi
```

阈值依据：满额一轮 +313，凌晨残余 +33，中间的 100 分留足余量。没写标记 → 后面的备用时段会继续重试。

### 防护 3：调度器改用 done key 判据

原来两版兜底脚本（`ensure-daily-run.mjs` / `dispatch-gitee.cjs`）判断「今天跑没跑」是看 run 的 success + job 级 success。问题是：**gate 判定跳过时 job 也是 skipped，但 run 整体仍可能是 success**，容易误判成「已签到」。

现在优先查 **Actions 缓存里的完成标记**：

- rewards：「`rewards-done-<北京日期>`」，调度器设 `doneKey: "rewards-done-"`、`notBeforeHour: 6`
- kgcheckin：「`kg-done-<北京日期>`」，`doneKey: "kg-done-"`、`notBeforeHour: 1`

命中标记 → 直接判定今天已完成，**不再下钻 jobs**（省 3 次 API 调用，也不受 run 状态误导）。没命中才回退到 job 级校验。

两版都加了同一条时间窗闸：

- `ensure-daily-run.mjs`：`if (!FORCE && typeof t.notBeforeHour === "number" && hour < t.notBeforeHour) continue;`
- `dispatch-gitee.cjs`：同逻辑，记 `result.action = "too-early"`

### 防护 4：Gitee 流水线 cron 整体后移

`.workflow/rewards-dispatcher.yml` 的定时从 `0 0 */3 * * ?`（每 3 小时，含 00:00）改成：

```yaml
schedule:
  - cron: '0 30 6,9,12,15,18,21 * * ?'
```

即北京 **06:30 / 09:30 / 12:30 / 15:30 / 18:30 / 21:30**，全部排在重置之后。每天 6 次 = 180 次/月 ≈ 180 分钟，在 500 分钟/月免费额度内。

### 实测验证

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| GitHub 时间窗闸 | `gh workflow run rewards-daily`（北京 00:43） | run 43910629734：gate success，**执行签到 skipped**，日志 `##[notice]现在是北京 0 点，早于 06:00` |
| 本机调度器时间窗 | `node scripts/ci/ensure-daily-run.mjs --dry` | `[rewards-daily] 现在北京 0 点，早于 6 点，等下一个窗口` |
| Gitee 调度器时间窗 | 构建 #3（00:50:24，commit 32fce28） | 日志含 `[rewards-daily] 现在北京 0 点，早于 6 点，等下一个窗口` + `[kgcheckin-签到] 现在北京 0 点，早于 1 点，等下一个窗口` + `=== run end ===` + `=== exit=0 ===`，构建 success |
| done key 命中 | 临时脚本调 `doneKeyExists` | rewards → `null`（标记已删）；kg → `HIT kg-done-2026-11-17 @ 2026-11-16T16:26:11Z` |
| Gitee 构建 #4 | 01:0x，commit 91fc909 | runner 横幅升 `v4-donekey` |

### 需要知道的一个取舍

这些闸门是**保守**的：宁可某个时段不跑，也不要写好标记把当天机会锁死。
所以如果真的想立刻强制跑一轮（比如怀疑微软提前放任务），用：

```powershell
gh workflow run rewards-daily -f force=true     # 忽略时间窗和今日标记
node scripts/ci/ensure-daily-run.mjs --force    # 本机调度器强制
```
