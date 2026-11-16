#!/usr/bin/env node
/**
 * 微软积分邮件报告 —— 零依赖（node:fs / node:os / node:path / node:tls / node:sqlite）
 *
 * 用法：
 *   node scripts/notify/mail-report.mjs capture     # 运行前快照积分（API），写 .points-before.json
 *   node scripts/notify/mail-report.mjs report      # 运行后：优先解析签到日志取积分，API 兜底，发邮件
 *   node scripts/notify/mail-report.mjs send        # 直接发（不对比）
 *   node scripts/notify/mail-report.mjs dry         # 只打印正文不发
 *
 * 环境变量：
 *   MAIL_FROM       发件邮箱（默认 laixinqb@foxmail.com）
 *   MAIL_AUTH       SMTP 授权码
 *   MAIL_TO         收件人，逗号分隔
 *   SMTP_HOST       默认 smtp.qq.com
 *   SMTP_PORT       默认 465（implicit TLS）
 *   RUN_STATUS      job 结论（success/failure）
 *   RUN_LOG         签到日志路径（默认 ./rewards-run.log）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { DatabaseSync } from 'node:sqlite';

const TARGET = { name: '中国石化礼品卡 500 元', points: 96530 };
const MAIL_FROM = process.env.MAIL_FROM || 'laixinqb@foxmail.com';
const MAIL_AUTH = process.env.MAIL_AUTH || '';
const MAIL_TO = (process.env.MAIL_TO || '3766308071@qq.com').split(',').map(s => s.trim()).filter(Boolean);
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.qq.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const RUN_STATUS = process.env.RUN_STATUS || 'unknown';

const SNAPSHOT_FILE = path.resolve(process.cwd(), '.points-before.json');
const RUN_LOG = path.resolve(process.cwd(), process.env.RUN_LOG || 'rewards-run.log');
const SESSION_CANDIDATES = [
  path.resolve(process.cwd(), 'sessions', 'sessions.db'),
  path.resolve(process.cwd(), 'sessions.db')
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';

const log = (...a) => console.log('[mail-report]', ...a);
const stripAnsi = s => String(s || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/* ---------------- 一、从签到日志里取积分（最可靠） ---------------- */
function parseRunLog(file = RUN_LOG) {
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    const buf = fs.readFileSync(file);
    // 兼容 UTF-16LE（PowerShell 重定向产物）与 UTF-8
    if (buf[0] === 0xff && buf[1] === 0xfe) raw = buf.toString('utf16le');
    else if (buf[0] === 0xfe && buf[1] === 0xff) raw = Buffer.from(buf).swap16().toString('utf16le');
    else raw = buf.toString('utf8');
  } catch { return null; }
  const lines = raw.split(/\r?\n/).map(stripAnsi);

  let after = null, before = null, gained = null, streak = null;
  for (const line of lines) {
    // MAIN [RUN-END] 全部账户完成 | 处理账户数=1 | 获得积分=27 | 原余额=10478 | 现余额=10505 | 运行分钟数=14.9
    // MAIN [ACCOUNT-END] 账户完成: *** | 获得积分=27 | 原余额=10478 | 现余额=10505
    const mRun = line.match(/RUN-END.*?获得积分=(-?\d+).*?原余额=(\d+).*?现余额=(\d+)/);
    if (mRun) { gained = Number(mRun[1]); before = Number(mRun[2]); after = Number(mRun[3]); continue; }
    const mAcc = line.match(/ACCOUNT-END.*?获得积分=(-?\d+).*?原余额=(\d+).*?现余额=(\d+)/);
    if (mAcc) { gained = Number(mAcc[1]); before = Number(mAcc[2]); after = Number(mAcc[3]); continue; }
    const mFlow = line.match(/MAIN \[FLOW\] 积分已收集.*?现余额=(\d+)/);
    if (mFlow && after == null) after = Number(mFlow[1]);
    const mStreak = line.match(/连续计数=(\d+)/);
    if (mStreak && streak == null) streak = Number(mStreak[1]);
  }
  if (after == null) return null;
  return { after, before, gained: gained ?? (before != null ? after - before : null), streak };
}

/* ---------------- 二、从 sessions.db + API 取积分（兜底） ---------------- */
function findDb() {
  for (const p of SESSION_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function readSessionRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT email, platform, storage_state FROM sessions ORDER BY platform').all();
  } finally {
    db.close();
  }
}

function pickSession(rows) {
  for (const pref of ['desktop', 'mobile']) {
    const row = rows.find(r => r.platform === pref && r.storage_state);
    if (row) {
      try { return { email: row.email, platform: row.platform, cookies: JSON.parse(row.storage_state).cookies || [] }; } catch {}
    }
  }
  return null;
}

/** 只挑 rewards/bing/live 域的 cookie，并按 name 去重（同名的优先 .bing.com 域） */
function buildCookieJar(cookies) {
  const wanted = c => {
    const d = String(c.domain || '').replace(/^(\.|#HttpOnly_)/, '').toLowerCase();
    return d === 'bing.com' || d.endsWith('.bing.com') || d === 'live.com' || d.endsWith('.live.com') || d.endsWith('.microsoft.com');
  };
  const score = c => {
    const d = String(c.domain || '').toLowerCase();
    if (d === 'bing.com' || d === '.bing.com') return 3;
    if (d.endsWith('.bing.com')) return 2;
    if (d.endsWith('.live.com')) return 2;
    return 1;
  };
  const best = new Map();
  for (const c of cookies) {
    if (!c || !c.name || !wanted(c)) continue;
    if (c.expires && c.expires > 0 && c.expires * 1000 < Date.now()) continue;
    const prev = best.get(c.name);
    if (!prev || score(c) >= score(prev)) best.set(c.name, c);
  }
  return [...best.values()].map(c => `${c.name}=${c.value}`).join('; ');
}

async function fetchPointsFromApi() {
  const dbPath = findDb();
  if (!dbPath) return { ok: false, error: `找不到 sessions.db（查找过 ${SESSION_CANDIDATES.join(', ')}）` };
  const sess = pickSession(readSessionRows(dbPath));
  if (!sess) return { ok: false, error: 'sessions.db 里没有可用会话行' };

  const jar = buildCookieJar(sess.cookies);
  const res = await fetch('https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest', {
    headers: {
      cookie: jar,
      'user-agent': UA,
      accept: 'application/json',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      referer: 'https://rewards.bing.com/dashboard'
    }
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, email: sess.email };
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, error: '响应不是合法 JSON（cookie 可能已失效）', email: sess.email }; }
  const us = json?.dashboard?.userStatus;
  if (!us) return { ok: false, error: '响应里没有 userStatus（可能需要重新登录）', email: sess.email };
  return {
    ok: true,
    email: sess.email,
    availablePoints: us.availablePoints ?? 0,
    lifetimePoints: us.lifetimePoints ?? 0,
    level: us.levelInfo?.activeLevelName || '未知',
    progress: us.levelInfo?.progress ?? null,
    progressMax: us.levelInfo?.progressMax ?? null
  };
}

function readEmailFromDb() {
  const dbPath = findDb();
  if (!dbPath) return null;
  try {
    const rows = readSessionRows(dbPath);
    return rows[0]?.email || null;
  } catch { return null; }
}

/* ---------------- 三、汇总数据 ---------------- */
async function collect() {
  const fromLog = parseRunLog();
  const api = await fetchPointsFromApi().catch(e => ({ ok: false, error: e.message }));

  let before = null;
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) before = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')).points ?? null;
  } catch {}

  const email = api.ok ? api.email : (fromLog?.email || readEmailFromDb() || '3766308071@qq.com');
  const available = fromLog ? fromLog.after : (api.ok ? api.availablePoints : null);
  const prev = fromLog?.before ?? before;
  const gained = fromLog?.gained ?? (available != null && prev != null ? available - prev : null);

  return {
    source: fromLog ? '签到日志' : api.ok ? 'Rewards API' : '无',
    email,
    available,
    lifetime: api.ok ? api.lifetimePoints : null,
    level: api.ok ? api.level : null,
    progress: api.ok ? api.progress : null,
    progressMax: api.ok ? api.progressMax : null,
    before: prev,
    gained,
    streak: fromLog?.streak ?? null,
    apiError: api.ok ? null : api.error
  };
}

/* ---------------- 四、SMTP ---------------- */
function smtpSession() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST, rejectUnauthorized: true }, () => {});
    let buf = '';
    const queue = [];
    let waiter = null;

    const flush = () => {
      const lines = buf.split('\r\n');
      let last = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i])) last = i;
      if (last === -1) return;
      const resp = lines.slice(0, last + 1).join('\n');
      buf = lines.slice(last + 1).join('\r\n');
      if (waiter) { const w = waiter; waiter = null; w.resolve(resp); } else queue.push(resp);
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

    const write = line => new Promise((res, rej) => sock.write(line + '\r\n', err => (err ? rej(err) : res())));

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

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
function wrap76(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join('\r\n');
}
function localHostname() {
  try { return os.hostname() || 'rewards-bot'; } catch { return 'rewards-bot'; }
}

async function sendMail({ subject, text }) {
  if (!MAIL_AUTH) throw new Error('缺少 MAIL_AUTH（授权码）');
  const { sock, cmd, write } = await smtpSession();
  try {
    await cmd(null, ['2']);
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

    await write(headers + '\r\n\r\n' + wrap76(b64(text)));
    await cmd('.', ['2']);
    await cmd('QUIT', ['2']).catch(() => {});
  } finally {
    try { sock.end(); } catch {}
  }
}

/* ---------------- 五、报告正文 ---------------- */
const fmt = n => Number(n || 0).toLocaleString('en-US');
const fmtOpt = n => (n == null ? '—' : fmt(n));

function buildReport(d) {
  const now = d.available;
  const gap = now == null ? null : Math.max(0, TARGET.points - now);
  const reached = now != null && now >= TARGET.points;
  const diff = d.gained;

  const L = [];
  L.push('Microsoft Rewards 每日签到报告');
  L.push('================================');
  L.push('');
  L.push(`时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
  L.push(`账号：${d.email}`);
  L.push(`运行状态：${RUN_STATUS === 'success' ? '✅ 执行成功' : RUN_STATUS === 'failure' ? '❌ 执行失败（详见 Actions 日志）' : 'ℹ️ ' + RUN_STATUS}`);
  L.push('');
  L.push('【当前积分】');
  L.push(`  可用积分：${fmtOpt(now)} 分`);
  if (d.lifetime != null) L.push(`  累计积分：${fmt(d.lifetime)} 分`);
  if (d.level) L.push(`  会员等级：${d.level}${d.progress != null ? `（进度 ${fmt(d.progress)}/${fmt(d.progressMax)}）` : ''}`);
  if (d.streak != null) L.push(`  连续签到：${d.streak} 天`);
  if (diff != null) L.push(`  本次运行：${diff >= 0 ? '+' : ''}${fmt(diff)} 分${d.before != null ? `（${fmt(d.before)} → ${fmt(now)}）` : ''}`);
  L.push('');
  L.push('【目标进度】');
  L.push(`  目标：${TARGET.name}（${fmt(TARGET.points)} 分）`);
  if (now == null) {
    L.push('  当前差距：积分获取失败，无法计算');
  } else if (reached) {
    L.push(`  🎉 已达目标！超出 ${fmt(now - TARGET.points)} 分，可以去兑换了。`);
  } else {
    L.push(`  当前差距：还差 ${fmt(gap)} 分`);
    L.push(`  完成度：${((now / TARGET.points) * 100).toFixed(2)}%`);
    L.push(`  进度条：[${'█'.repeat(Math.round((now / TARGET.points) * 20)).padEnd(20, '·')}]`);
    if (diff && diff > 0) L.push(`  按本次 ${fmt(diff)} 分/天估算，还需约 ${Math.ceil(gap / diff)} 天`);
  }
  L.push('');
  L.push(`数据来源：${d.source}`);
  L.push('');
  L.push('—— 本邮件由 GitHub Actions 自动发送');

  const subject = now == null
    ? '微软积分日报：积分获取失败（详见日志）'
    : `微软积分日报：${fmt(now)} 分（距${TARGET.name}还差 ${fmt(gap)} 分）`;
  return { subject, text: L.join('\n') };
}

/* ---------------- 六、主流程 ---------------- */
async function main() {
  const mode = process.argv[2] || 'report';

  if (mode === 'capture') {
    const p = await fetchPointsFromApi();
    if (!p.ok) { log('capture 跳过：', p.error); return; }
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ at: Date.now(), points: p.availablePoints, email: p.email }));
    log(`capture 完成：${p.email} = ${p.availablePoints} 分`);
    return;
  }

  const data = await collect();
  const { subject, text } = buildReport(data);
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
