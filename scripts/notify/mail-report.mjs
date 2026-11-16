#!/usr/bin/env node
/**
 * 微软积分邮件报告 —— 零依赖，手写 SMTP over TLS
 *
 * 用法：
 *   node scripts/notify/mail-report.mjs capture     # 运行前快照积分，写 .points-before.json
 *   node scripts/notify/mail-report.mjs report      # 运行后取积分 + 发邮件
 *   node scripts/notify/mail-report.mjs send        # 直接发（不对比）
 *
 * 环境变量：
 *   MAIL_FROM       发件邮箱（默认 laixinqb@foxmail.com）
 *   MAIL_AUTH       授权码
 *   MAIL_TO         收件人，逗号分隔
 *   SMTP_HOST       默认 smtp.qq.com
 *   SMTP_PORT       默认 465（implicit TLS）
 *   RUN_STATUS      上次 npm start 的结论（可选，success/failure）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { DatabaseSync } from 'node:sqlite';

const TARGET = { name: '中国石化礼品卡 500 元', points: 96530 };
const MAIL_FROM = process.env.MAIL_FROM || 'laixinqb@foxmail.com';
const MAIL_AUTH = process.env.MAIL_AUTH || '';
const MAIL_TO = (process.env.MAIL_TO || '3766308071@qq.com,525177186@qq.com').split(',').map(s => s.trim()).filter(Boolean);
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.qq.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const RUN_STATUS = process.env.RUN_STATUS || 'unknown';

const SNAPSHOT_FILE = path.resolve(process.cwd(), '.points-before.json');
const SESSION_CANDIDATES = [
  path.resolve(process.cwd(), 'sessions', 'sessions.db'),
  path.resolve(process.cwd(), 'sessions.db')
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';

const log = (...a) => console.log('[mail-report]', ...a);

/* ---------------- 读取积分 ---------------- */
function findDb() {
  for (const p of SESSION_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function loadCookieJar(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows = [];
  try {
    rows = db.prepare('SELECT email, platform, storage_state FROM sessions ORDER BY platform').all();
  } finally {
    db.close();
  }
  for (const pref of ['desktop', 'mobile']) {
    const row = rows.find(r => r.platform === pref && r.storage_state);
    if (row) {
      const state = JSON.parse(row.storage_state);
      return { email: row.email, platform: row.platform, cookies: state.cookies || [] };
    }
  }
  return null;
}

async function fetchPoints() {
  const dbPath = findDb();
  if (!dbPath) return { ok: false, error: `找不到 sessions.db（查找过 ${SESSION_CANDIDATES.join(', ')}）` };
  const sess = loadCookieJar(dbPath);
  if (!sess) return { ok: false, error: 'sessions.db 里没有可用会话行' };

  const jar = sess.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const url = 'https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest';
  const res = await fetch(url, {
    headers: {
      cookie: jar,
      'user-agent': UA,
      accept: 'application/json',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, error: '响应不是合法 JSON（可能 cookie 已失效）' }; }
  const us = json?.dashboard?.userStatus;
  if (!us) return { ok: false, error: '响应里没有 userStatus（可能需要重新登录）' };

  return {
    ok: true,
    email: sess.email,
    platform: sess.platform,
    availablePoints: us.availablePoints ?? 0,
    lifetimePoints: us.lifetimePoints ?? 0,
    level: us.levelInfo?.activeLevelName || '未知',
    progress: us.levelInfo?.progress ?? null,
    progressMax: us.levelInfo?.progressMax ?? null,
    country: us.primaryEarningCountryName || ''
  };
}

/* ---------------- SMTP ---------------- */
function smtpSession() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST, rejectUnauthorized: true }, () => {});
    let buf = '';
    const queue = [];
    let waiter = null;

    const flush = () => {
      const idxs = [];
      const lines = buf.split('\r\n');
      let last = -1;
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) last = i;
      }
      if (last === -1) return;
      const consumed = lines.slice(0, last + 1);
      buf = lines.slice(last + 1).join('\r\n');
      const resp = consumed.join('\n');
      if (waiter) { const w = waiter; waiter = null; w.resolve(resp); }
      else queue.push(resp);
    };

    sock.on('data', d => { buf += d.toString('utf8'); flush(); });
    sock.on('error', e => {
      if (waiter) { const w = waiter; waiter = null; w.reject(e); } else reject(e);
    });
    sock.on('close', () => {
      if (waiter) { const w = waiter; waiter = null; w.reject(new Error('SMTP 连接被关闭')); }
    });

    const read = () => new Promise((res, rej) => {
      if (queue.length) return res(queue.shift());
      waiter = { resolve: res, reject: rej };
      setTimeout(() => {
        if (waiter && waiter.reject === rej) { waiter = null; rej(new Error('SMTP 读取超时')); }
      }, 30000);
    });

    const write = line => new Promise((res, rej) => {
      sock.write(line + '\r\n', err => (err ? rej(err) : res()));
    });

    const cmd = async (line, okCodes = ['2', '3']) => {
      if (line) await write(line);
      const resp = await read();
      const code = resp.slice(0, 3);
      if (!okCodes.some(c => code.startsWith(c))) throw new Error(`SMTP ${code}: ${resp.replace(/\n/g, ' | ').slice(0, 200)}`);
      return resp;
    };

    resolve({ sock, cmd, write });
  });
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

function wrap76(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join('\r\n');
}

async function sendMail({ subject, text }) {
  if (!MAIL_AUTH) throw new Error('缺少 MAIL_AUTH（授权码）');
  const { sock, cmd, write } = await smtpSession();
  try {
    await cmd(null, ['2']);                                   // 220 greeting
    await cmd(`EHLO ${localHostname()}`, ['2']);
    await cmd('AUTH LOGIN', ['3']);
    await cmd(b64(MAIL_FROM), ['3']);
    await cmd(b64(MAIL_AUTH), ['2']);
    await cmd(`MAIL FROM:<${MAIL_FROM}>`, ['2']);
    for (const rcpt of MAIL_TO) await cmd(`RCPT TO:<${rcpt}>`, ['2']);
    await cmd('DATA', ['3']);

    const headers = [
      `From: =?UTF-8?B?${b64('Microsoft Rewards 签到助手')}?= <${MAIL_FROM}>`,
      `To: ${MAIL_TO.join(', ')}`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@foxmail.com>`
    ].join('\r\n');

    const body = wrap76(Buffer.from(text, 'utf8').toString('base64'));
    await write(headers + '\r\n\r\n' + body);
    await cmd('.', ['2']);
    await cmd('QUIT', ['2']).catch(() => {});
  } finally {
    try { sock.end(); } catch {}
  }
}

function localHostname() {
  try { return os.hostname() || 'rewards-bot'; } catch { return 'rewards-bot'; }
}

/* ---------------- 报告内容 ---------------- */
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

function buildReport(points, before) {
  const now = points.availablePoints;
  const gap = Math.max(0, TARGET.points - now);
  const reached = now >= TARGET.points;
  const diff = before != null ? now - before : null;

  const lines = [];
  lines.push('Microsoft Rewards 每日签到报告');
  lines.push('================================');
  lines.push('');
  lines.push(`时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
  lines.push(`账号：${points.email}`);
  lines.push(`运行状态：${RUN_STATUS === 'success' ? '✅ 执行成功' : RUN_STATUS === 'failure' ? '❌ 执行失败（详见下方说明）' : 'ℹ️ ' + RUN_STATUS}`);
  lines.push('');
  lines.push('【当前积分】');
  lines.push(`  可用积分：${fmt(now)} 分`);
  lines.push(`  累计积分：${fmt(points.lifetimePoints)} 分`);
  lines.push(`  会员等级：${points.level}${points.progress != null ? `（进度 ${fmt(points.progress)}/${fmt(points.progressMax)}）` : ''}`);
  if (diff != null) {
    lines.push(`  本次运行：${diff >= 0 ? '+' : ''}${fmt(diff)} 分`);
  }
  lines.push('');
  lines.push('【目标进度】');
  lines.push(`  目标：${TARGET.name}（${fmt(TARGET.points)} 分）`);
  if (reached) {
    lines.push(`  🎉 已达目标！超出 ${fmt(now - TARGET.points)} 分，可以去兑换了。`);
  } else {
    lines.push(`  当前差距：还差 ${fmt(gap)} 分`);
    lines.push(`  完成度：${((now / TARGET.points) * 100).toFixed(2)}%`);
    lines.push(`  进度条：[${'█'.repeat(Math.round((now / TARGET.points) * 20)).padEnd(20, '·')}]`);
    if (diff && diff > 0) {
      lines.push(`  按本次 ${fmt(diff)} 分/天估算，还需约 ${Math.ceil(gap / diff)} 天`);
    }
  }
  lines.push('');
  lines.push('—— 本邮件由 GitHub Actions 自动发送');
  return { subject: `微软积分日报：${fmt(now)} 分（距${TARGET.name}还差 ${fmt(gap)} 分）`, text: lines.join('\n') };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const mode = process.argv[2] || 'report';

  if (mode === 'capture') {
    const p = await fetchPoints();
    if (!p.ok) { log('capture 跳过：', p.error); return; }
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ at: Date.now(), points: p.availablePoints, email: p.email }));
    log(`capture 完成：${p.email} = ${p.availablePoints} 分`);
    return;
  }

  let before = null;
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) before = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')).points;
  } catch {}

  let points = await fetchPoints();
  if (!points.ok) {
    log('取积分失败：', points.error);
    points = { ok: false, email: '未知', availablePoints: 0, lifetimePoints: 0, level: '未知' };
  }

  const { subject, text } = buildReport(points, before);
  console.log('---- 邮件正文 ----');
  console.log(text);
  console.log('------------------');

  if (mode === 'dry') { log('dry 模式，不发送'); return; }
  await sendMail({ subject, text });
  log(`已发送给：${MAIL_TO.join(', ')}`);
}

main().catch(err => {
  console.error('[mail-report] 失败：', err.message);
  process.exit(1);
});
