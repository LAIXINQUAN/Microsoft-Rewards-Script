#!/usr/bin/env node
'use strict';
/*
 * 签到兜底调度器 —— Gitee Go / 任意 Node 12+ 环境专用版（v3）
 * ---------------------------------------------------------------
 * v1/v2 在 Gitee 容器里的真实故障：
 *   rewards-daily 那行打出来后，下一个目标的 api.github.com 请求卡住，
 *   Promise 链悬空 → 所有 handle 释放 → 事件循环清空 → Node 14 以 exit 0
 *   静默退出，后面的日志（kgcheckin、run end、结果汇总）全部丢失。
 *   gitee-run.sh 看到 exit=0 就以为成功了。
 *
 * v3 的三道保险：
 *   1. log() 用 fs.writeSync(1, ...) 同步写 fd 1 —— 进程任何时刻死掉都不丢日志
 *   2. 每个 HTTP 请求套 Promise.race 硬超时（15s）—— socket 层不触发也能 reject
 *   3. 全局保活定时器（未 unref）—— 事件循环永远不会空，进程不会自己溜走；
 *      同时它是最后一道闸：110s 还没跑完就强制收尾并以 exit 1 结束
 *
 * 用法：
 *   GH_TOKEN=xxx node dispatch-gitee.cjs          正常跑
 *   GH_TOKEN=xxx node dispatch-gitee.cjs --dry    只看判断，不触发
 *   GH_TOKEN=xxx node dispatch-gitee.cjs --force  忽略「今天已完成」
 *   GH_TOKEN=xxx node dispatch-gitee.cjs --only=kg 只处理名字含 kg 的目标
 *
 * 退出码：0 全部正常；1 有目标出错或整体超时；2 --only 没匹配到目标
 */

const https = require('https');
const fs = require('fs');

const REQ_TIMEOUT_MS = 20000;
const GLOBAL_TIMEOUT_MS = 150000;
const RETRY_DELAYS = [400, 1200, 2500];
// 只拉最近的 run 就够判断「今天是否已成功」；
// per_page=60 时 kgcheckin 那个仓库的响应要 14 秒（实测），per_page=20 快得多。
const RUNS_PER_PAGE = 20;

/*
 * doneKey：签到 workflow 自己写的「我今天真的拿到分了」标记（存成 Actions 缓存）。
 * 为什么不用「run 成功」当判据：微软每日任务在中国区不是北京 00:00 重置，
 * 凌晨那一趟只能捞到前一天残余的几十点，签到 job 照样 success，
 * 但只要拿到分就会去写 done key —— 加阈值后写不成，正好区分得开。
 * notBeforeHour：北京时间几点之前不触发。
 */
const TARGETS = [
  {
    label: 'rewards-daily',
    repo: 'LAIXINQUAN/Microsoft-Rewards-Script',
    workflowId: '420202401',
    ref: 'V4-china',
    jobRe: /执行签到|签到/,
    doneKey: 'rewards-done-',
    notBeforeHour: 6
  },
  {
    label: 'kgcheckin-签到',
    repo: 'LAIXINQUAN/kgcheckin',
    workflowId: '372755970',
    ref: 'main',
    jobRe: /执行签到|签到/,
    doneKey: 'kg-done-',
    notBeforeHour: 1
  }
];

// 同步写，绝不丢日志
function raw(s) {
  try { fs.writeSync(1, s + '\n'); } catch (e) { /* ignore */ }
}

function log() {
  const args = Array.prototype.slice.call(arguments);
  const stamp = new Date().toISOString().replace('T', ' ').replace('Z', 'Z');
  raw('[' + stamp + '] ' + args.join(' '));
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// 兜底超时：不管底层 socket 处于什么状态，到点必 reject
function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error('timeout ' + ms + 'ms ' + label));
    }, ms);
    promise.then(function (v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }, function (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

function beijingDate(d) {
  const t = (d ? d.getTime() : Date.now()) + 8 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

function beijingHour(d) {
  const t = (d ? d.getTime() : Date.now()) + 8 * 3600 * 1000;
  return new Date(t).getUTCHours();
}

function ghOnce(method, pathname, body, token) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const finish = function (fn, v) {
      if (settled) return;
      settled = true;
      fn(v);
    };
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rewards-dispatcher-gitee'
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({
      hostname: 'api.github.com',
      port: 443,
      path: pathname,
      method: method,
      headers: headers
    }, function (res) {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { out += c; });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!out) return finish(resolve, {});
          let parsed = {};
          try { parsed = JSON.parse(out); } catch (e) { parsed = {}; }
          finish(resolve, parsed);
        } else {
          const err = new Error('HTTP ' + res.statusCode + ' ' + pathname + ' -> ' + out.slice(0, 200));
          err.statusCode = res.statusCode;
          finish(reject, err);
        }
      });
      res.on('aborted', function () { finish(reject, new Error('aborted ' + pathname)); });
      res.on('error', function (e) { finish(reject, e); });
    });
    req.on('error', function (e) { finish(reject, e); });
    if (data) req.write(data);
    req.end();
  });
}

// 4xx（除 429）是确定性错误，重试没意义；其余（超时/重置/5xx）重试。
function ghRequest(method, pathname, body, token) {
  let attempt = 0;
  function tryOnce() {
    return withTimeout(ghOnce(method, pathname, body, token), REQ_TIMEOUT_MS, method + ' ' + pathname)
      .catch(function (e) {
        const code = e && e.statusCode;
        const fatal = code && code >= 400 && code < 500 && code !== 429;
        if (fatal || attempt >= RETRY_DELAYS.length) throw e;
        const wait = RETRY_DELAYS[attempt];
        attempt += 1;
        log('  ~ ' + method + ' ' + pathname + ' 第 ' + attempt + ' 次失败（' + String(e && e.message).slice(0, 100) + '），' + wait + 'ms 后重试');
        return sleep(wait).then(tryOnce);
      });
  }
  return tryOnce();
}

// 直接查 Actions 缓存里有没有「今天的 done key」——签到 workflow 真正拿到分才会写。
function doneKeyExists(token, target, today) {
  if (!target.doneKey) return Promise.resolve(null);
  const want = target.doneKey + today;
  return ghRequest('GET', '/repos/' + target.repo + '/actions/caches?per_page=100', null, token)
    .then(function (data) {
      const list = (data && data.actions_caches) || [];
      for (let i = 0; i < list.length; i++) {
        if (list[i].key === want) return list[i];
      }
      return null;
    })
    .catch(function (e) {
      log('  ! 查 done key 失败：' + String(e && e.message).slice(0, 140));
      return null;
    });
}

// run 的 conclusion=success 可能只是 gate 判定「今天已完成」后跳过了执行 job。
// 所以必须下钻到 jobs，确认真有名字匹配的 job 且 conclusion=success。
function reallySucceeded(token, target, runId) {
  return ghRequest('GET', '/repos/' + target.repo + '/actions/runs/' + runId + '/jobs?per_page=100', null, token)
    .then(function (data) {
      const jobs = (data && data.jobs) || [];
      for (let i = 0; i < jobs.length; i++) {
        if (jobs[i].conclusion === 'success' && target.jobRe.test(jobs[i].name || '')) return true;
      }
      return false;
    })
    .catch(function (e) {
      log('  ! 查 run ' + runId + ' 的 jobs 失败：' + String(e && e.message).slice(0, 140));
      return false;
    });
}

function alreadyDoneToday(token, target, today) {
  // 先看 done key —— 签到 workflow 真正拿到分才会写这个缓存
  return doneKeyExists(token, target, today).then(function (hit) {
    if (hit) {
      return { done: true, runId: 'cache:' + hit.key, via: 'cache' };
    }
    return ghRequest('GET', '/repos/' + target.repo + '/actions/workflows/' + target.workflowId + '/runs?per_page=' + RUNS_PER_PAGE, null, token)
      .then(function (data) {
        const runs = (data && data.workflow_runs) || [];
        const todays = runs.filter(function (r) {
          return beijingDate(new Date(r.created_at)) === today;
        });
        for (let i = 0; i < todays.length; i++) {
          const s = todays[i].status;
          if (s === 'in_progress' || s === 'queued' || s === 'waiting' || s === 'requested' || s === 'pending') {
            return { done: false, running: true, runId: todays[i].id };
          }
        }
        const succ = todays.filter(function (r) { return r.conclusion === 'success'; }).slice(0, 3);
        return succ.reduce(function (p, r) {
          return p.then(function (acc) {
            if (acc.done) return acc;
            return reallySucceeded(token, target, r.id).then(function (ok) {
              return ok ? { done: true, runId: r.id, via: 'jobs' } : acc;
            });
          });
        }, Promise.resolve({ done: false, runId: null }));
      });
  });
}

function dispatchWorkflow(token, target) {
  return ghRequest('POST', '/repos/' + target.repo + '/actions/workflows/' + target.workflowId + '/dispatches',
    { ref: target.ref }, token);
}

function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const cp = require('child_process');
    const out = cp.execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).trim();
  } catch (e) {
    return '';
  }
}

function handleOne(token, t, today, opts, results) {
  const hour = beijingHour();
  if (!opts.force && typeof t.notBeforeHour === 'number' && hour < t.notBeforeHour) {
    log('[' + t.label + '] 现在北京 ' + hour + ' 点，早于 ' + t.notBeforeHour + ' 点，等下一个窗口');
    results.push({ label: t.label, action: 'too-early' });
    return Promise.resolve(null);
  }
  return alreadyDoneToday(token, t, today)
    .catch(function (e) {
      // 查不到不代表没签到；记下来，走触发（GitHub 侧 gate 会兜住重复）
      log('[' + t.label + '] 查询今日状态失败：' + String(e && e.message).slice(0, 160));
      return { done: false, running: false, runId: null, queryFailed: true };
    })
    .then(function (st) {
      if (st.done && !opts.force) {
        log('[' + t.label + '] 今天已成功（' + (st.via === 'cache' ? '标记 ' : 'run ') + st.runId + '），无需触发');
        results.push({ label: t.label, action: 'skip', runId: st.runId });
        return null;
      }
      if (st.running && !opts.force) {
        log('[' + t.label + '] 今天已有任务在跑（run ' + st.runId + '），不重复触发');
        results.push({ label: t.label, action: 'running', runId: st.runId });
        return null;
      }
      if (opts.dry) {
        log('[' + t.label + '] 今天还没成功 —— DRY 模式，不实际触发');
        results.push({ label: t.label, action: 'would-dispatch' });
        return null;
      }
      return dispatchWorkflow(token, t)
        .then(function () {
          log('[' + t.label + '] 今天还没成功，已触发 -> ' + t.repo + ' workflow ' + t.workflowId + ' ref ' + t.ref);
          results.push({ label: t.label, action: 'dispatched' });
        })
        .catch(function (e) {
          log('[' + t.label + '] 触发失败：' + String(e && e.message).slice(0, 160));
          results.push({ label: t.label, action: 'error', detail: String(e && e.message) });
        });
    });
}

function runAll(opts) {
  opts = opts || {};
  const token = getToken();
  const today = beijingDate();
  log('=== run start | 北京日期 ' + today + (opts.dry ? ' | DRY' : '') + ' ===');
  if (!token) {
    log('!! 没拿到 GH_TOKEN（流水线命令里应传 bash scripts/ci/gitee-run.sh \"<token>\"）');
    return Promise.resolve({ ok: false, detail: 'missing token' });
  }

  let targets = TARGETS;
  if (opts.only) {
    targets = TARGETS.filter(function (t) { return t.label.indexOf(opts.only) >= 0; });
    if (!targets.length) {
      log('!! --only=' + opts.only + ' 没匹配到任何目标');
      return Promise.resolve({ ok: false, detail: 'no target matched' });
    }
  }

  const results = [];
  return targets.reduce(function (p, t) {
    return p.then(function () {
      return handleOne(token, t, today, opts, results).catch(function (e) {
        log('[' + t.label + '] 未预期错误：' + String((e && e.stack) || e).slice(0, 400));
        results.push({ label: t.label, action: 'error', detail: String((e && e.message) || e) });
      });
    });
  }, Promise.resolve()).then(function () {
    const ok = results.every(function (r) { return r.action !== 'error'; });
    results.forEach(function (r) {
      log('  · ' + r.label + ' -> ' + r.action + (r.runId ? ' (run ' + r.runId + ')' : ''));
    });
    log('=== run end ===');
    return { ok: ok, today: today, results: results };
  });
}

module.exports = { runAll: runAll, TARGETS: TARGETS, beijingDate: beijingDate, beijingHour: beijingHour, doneKeyExists: doneKeyExists };

if (require.main === module) {
  // 全局保活 + 硬闸：ref 的定时器让事件循环永不空，进程不会「自己溜走」；
  // 到点还没结束就强制收尾，并以非 0 退出，让 Gitee 把这次构建标红。
  const globalTimer = setTimeout(function () {
    log('!! 全局超时 ' + GLOBAL_TIMEOUT_MS + 'ms，强制收尾');
    log('=== run end (forced) ===');
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  const argv = process.argv.slice(2);
  const opts = {
    dry: argv.indexOf('--dry') >= 0,
    force: argv.indexOf('--force') >= 0,
    only: (function () {
      const hit = argv.filter(function (a) { return a.indexOf('--only=') === 0; })[0];
      return hit ? hit.slice(7) : '';
    })()
  };
  runAll(opts)
    .then(function (r) {
      clearTimeout(globalTimer);
      if (!r.ok) process.exit(r.detail === 'no target matched' ? 2 : 1);
      process.exit(0);
    })
    .catch(function (e) {
      clearTimeout(globalTimer);
      raw('FATAL ' + ((e && e.stack) || e));
      process.exit(1);
    });
}
