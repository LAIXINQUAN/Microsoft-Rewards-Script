/**
 * 国内云函数版外部兜底调度器（腾讯云 SCF / 腾讯云 CloudBase / 阿里云 FC / 华为云 FunctionGraph 通用）
 *
 * 为什么单独写这一版：
 *   - 国内云函数 Node 运行时可能没有 global fetch，全部用内置 node:https 手写请求
 *   - 云函数所在地域时区不一定是北京时间，日期一律自己按 +8h 算，不依赖系统时区
 *   - 各平台 handler 名字不同，文件末尾同时导出 main_handler / main / handler
 *
 * 环境变量：GH_TOKEN = fine-grained PAT（需要 Actions: Read and write 权限）
 *
 * 定时触发器（每 30 分钟；下面用 0,30 展开写法，避免注释里出现斜杠星号）：
 *   腾讯云 SCF / CloudBase（7 段，北京时间）：秒=0 分=0,30 其余星号
 *   阿里云 FC / 华为云 FunctionGraph（6 段，UTC）：分=0,30 其余星号
 */

'use strict';

const https = require('https');

const TARGETS = [
  { label: 'rewards-daily',   repo: 'LAIXINQUAN/Microsoft-Rewards-Script', workflow: '420202401', ref: 'V4-china' },
  { label: 'kgcheckin-签到', repo: 'LAIXINQUAN/kgcheckin',               workflow: '372755970', ref: 'main' },
];

const UA = 'rewards-dispatcher-cn';

function beijingDate(d) {
  d = d || new Date();
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function token() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!t) throw new Error('环境变量 GH_TOKEN 未配置');
  return t;
}

function ghRequest(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token(),
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      { hostname: 'api.github.com', path: pathname, method: method, headers: headers, timeout: 20000 },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (!data) return resolve(null);
            try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
          } else {
            reject(new Error('HTTP ' + res.statusCode + ' ' + pathname + ' -> ' + data.slice(0, 300)));
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout ' + pathname)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// gate 判定「今天已完成」后跳过的 run 也是 conclusion=success，必须下钻到 job 级确认真的签到成功过
function reallySucceeded(run) {
  return ghRequest('GET', '/repos/' + run.repository.full_name + '/actions/runs/' + run.id + '/jobs')
    .then((jobs) => {
      const list = (jobs && jobs.jobs) || [];
      return list.some((j) => j.conclusion === 'success' && /执行签到|签到|run/i.test(j.name || ''));
    })
    .catch(() => false);
}

function alreadyDoneToday(target, today) {
  return ghRequest('GET', '/repos/' + target.repo + '/actions/workflows/' + target.workflow + '/runs?per_page=60')
    .then((data) => {
      const runs = ((data && data.workflow_runs) || []).filter((r) => beijingDate(new Date(r.created_at)) === today);
      const running = runs.find((r) => r.status === 'in_progress' || r.status === 'queued');
      if (running) return { running: running, ok: null };
      const candidates = runs.filter((r) => r.conclusion === 'success').slice(0, 3);
      // 串行检查，避免瞬间打出过多并发请求被 GitHub 限速
      let chain = Promise.resolve(null);
      candidates.forEach((run) => {
        chain = chain.then((found) => {
          if (found) return found;
          return reallySucceeded(run).then((yes) => (yes ? run : null));
        });
      });
      return chain.then((ok) => ({ running: null, ok: ok }));
    });
}

function runAll(event, context) {
  const today = beijingDate();
  const out = [];
  let chain = Promise.resolve();
  TARGETS.forEach((target) => {
    chain = chain.then(() => {
      return alreadyDoneToday(target, today)
        .then((r) => {
          if (r.running) {
            out.push(target.label + ': 正在跑（run ' + r.running.id + '），不处理');
            return null;
          }
          if (r.ok) {
            out.push(target.label + ': 今天已成功（run ' + r.ok.id + '），无需触发');
            return null;
          }
          return ghRequest('POST', '/repos/' + target.repo + '/actions/workflows/' + target.workflow + '/dispatches', { ref: target.ref })
            .then(() => { out.push(target.label + ': 今天还没成功 → 已 dispatch'); });
        })
        .catch((e) => { out.push(target.label + ': 出错 ' + (e && e.message ? e.message : e)); });
    });
  });
  return chain.then(() => {
    const msg = '[' + today + '] ' + out.join(' | ');
    console.log(msg);
    return { date: today, detail: out, message: msg };
  });
}

// 各平台 handler 名字不同，全部导出同一个实现
exports.main_handler = runAll; // 腾讯云 SCF
exports.main = runAll;         // 腾讯云 CloudBase 云开发
exports.handler = runAll;      // 阿里云函数计算 FC / 华为云 FunctionGraph / 百度 CFC / 火山 veFaaS
exports.runAll = runAll;       // 手动测试用