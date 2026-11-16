#!/usr/bin/env node
// 外部兜底调度器：检查两个仓库今天是否已成功签到，没成功就手动 dispatch。
// 用法：node scripts/ci/ensure-daily-run.mjs            # 正常跑
//       node scripts/ci/ensure-daily-run.mjs --dry    # 只看结论不触发
//       node scripts/ci/ensure-daily-run.mjs --force  # 忽略今日标记，强制 dispatch
// 依赖：Node 18+（built-in fetch）；token 从 GITHUB_TOKEN / GH_TOKEN 或 `gh auth token` 取。
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TARGETS = [
  {
    label: 'rewards-daily',
    repo: 'LAIXINQUAN/Microsoft-Rewards-Script',
    workflow: '420202401',
    ref: 'V4-china',
  },
  {
    label: 'kgcheckin-签到',
    repo: 'LAIXINQUAN/kgcheckin',
    workflow: '372755970',
    ref: 'main',
  },
];

const LOG_DIR = path.join(homedir(), '.rewards-dispatcher');
const LOG_FILE = path.join(LOG_DIR, 'log.txt');
const MAX_LOG = 256 * 1024;

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > MAX_LOG) writeFileSync(LOG_FILE, '');
    } catch {}
    appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

function beijingDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function getToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // 计划任务里的 PATH 可能不含 GitHub CLI 的安装目录，所以先试绝对路径。
  const absolute =
    process.platform === 'win32'
      ? [
          path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GitHub CLI', 'gh.exe'),
          path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'GitHub CLI', 'gh.exe'),
        ]
      : ['/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh'];
  const candidates = [...absolute, 'gh.exe', 'gh'];
  for (const cmd of candidates) {
    try {
      const out = execFileSync(cmd, ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out) return out;
    } catch {}
  }
  throw new Error('拿不到 GitHub token：设 GITHUB_TOKEN / GH_TOKEN 环境变量，或先跑 gh auth login');
}

const TOKEN = getToken();
const API = 'https://api.github.com';

async function api(pathname, init = {}) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rewards-dispatcher',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' ' + pathname + ' -> ' + text.slice(0, 300));
  }
  return text ? JSON.parse(text) : null;
}

// run 的 conclusion=success 可能只是 gate 判定「今天已完成」后跳过了执行 job，
// 所以要下钻到 job 级别确认真的有签到 job 跑成功过。
async function reallySucceeded(run) {
  const jobs = await api('/repos/' + run.repository.full_name + '/actions/runs/' + run.id + '/jobs');
  const list = (jobs && jobs.jobs) || [];
  return list.some((j) => j.conclusion === 'success' && /执行签到|签到|run/i.test(j.name));
}

async function alreadyDoneToday(target, today) {
  const data = await api(
    '/repos/' + target.repo + '/actions/workflows/' + target.workflow + '/runs?per_page=60'
  );
  const runs = (data && data.workflow_runs) || [];
  const todays = runs.filter((r) => beijingDate(new Date(r.created_at)) === today);
  const running = todays.find((r) => r.status === 'in_progress' || r.status === 'queued');

  let ok = null;
  const successRuns = todays.filter((r) => r.conclusion === 'success').slice(0, 3);
  for (const r of successRuns) {
    if (await reallySucceeded(r)) {
      ok = r;
      break;
    }
  }
  return { ok, running, count: todays.length };
}

async function dispatch(target) {
  await api('/repos/' + target.repo + '/actions/workflows/' + target.workflow + '/dispatches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: target.ref }),
  });
}

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const targets = ONLY ? TARGETS.filter((t) => t.label.includes(ONLY)) : TARGETS;
if (!targets.length) {
  log('没有匹配 --only=' + ONLY + ' 的目标，可选：' + TARGETS.map((t) => t.label).join(', '));
  process.exit(2);
}
const today = beijingDate();
log('=== run start | 北京日期 ' + today + (DRY ? ' | DRY' : '') + (FORCE ? ' | FORCE' : '') + ' ===');

let exitCode = 0;
for (const target of targets) {
  try {
    const state = await alreadyDoneToday(target, today);
    if (state.ok && !FORCE) {
      log('[' + target.label + '] 今天已成功（run ' + state.ok.id + '），无需触发');
      continue;
    }
    if (state.running && !FORCE) {
      log('[' + target.label + '] 今天有运行中实例（run ' + state.running.id + ' ' + state.running.status + '），跳过');
      continue;
    }
    const reason = FORCE ? 'FORCE' : state.count ? '今天有 ' + state.count + ' 次运行但都没成功' : '今天还没跑';
    if (DRY) {
      log('[' + target.label + '] 需要触发（' + reason + '）—— DRY 不动手');
      continue;
    }
    await dispatch(target);
    log('[' + target.label + '] 已 dispatch（' + reason + '）');
  } catch (err) {
    exitCode = 1;
    log('[' + target.label + '] 失败：' + (err && err.message ? err.message : String(err)));
  }
}

log('=== run end | exit ' + exitCode + ' ===');
process.exit(exitCode);
