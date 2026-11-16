/**
 * Cloudflare Worker 版外部兜底调度器
 * 与 scripts/ci/ensure-daily-run.mjs 逻辑一致：查今天的真实执行结果，没成功才 dispatch。
 * 部署见 ACTIONS-README.md「第三方平台兜底」章节。
 */

const TARGETS = [
  { label: 'rewards-daily', repo: 'LAIXINQUAN/Microsoft-Rewards-Script', workflow: '420202401', ref: 'V4-china' },
  { label: 'kgcheckin-签到', repo: 'LAIXINQUAN/kgcheckin', workflow: '372755970', ref: 'main' },
];

function beijingDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function api(env, pathname, init = {}) {
  const res = await fetch('https://api.github.com' + pathname, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + env.GH_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rewards-dispatcher-worker',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + pathname + ' -> ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

// gate 跳过的 run 也是 conclusion=success，必须下钻到 job 级别确认真的签到成功过。
async function reallySucceeded(env, run) {
  const jobs = await api(env, '/repos/' + run.repository.full_name + '/actions/runs/' + run.id + '/jobs');
  const list = (jobs && jobs.jobs) || [];
  return list.some((j) => j.conclusion === 'success' && /执行签到|签到|run/i.test(j.name));
}

async function alreadyDoneToday(env, target, today) {
  const data = await api(env, '/repos/' + target.repo + '/actions/workflows/' + target.workflow + '/runs?per_page=60');
  const runs = (data && data.workflow_runs) || [];
  const todays = runs.filter((r) => beijingDate(new Date(r.created_at)) === today);
  const running = todays.find((r) => r.status === 'in_progress' || r.status === 'queued');
  if (running) return { ok: null, running };

  const candidates = todays.filter((r) => r.conclusion === 'success').slice(0, 3);
  for (const r of candidates) {
    if (await reallySucceeded(env, r)) return { ok: r, running: null };
  }
  return { ok: null, running: null };
}

async function dispatch(env, target) {
  await api(env, '/repos/' + target.repo + '/actions/workflows/' + target.workflow + '/dispatches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: target.ref }),
  });
}

async function runAll(env, opts = {}) {
  const today = beijingDate();
  const out = [];
  for (const target of TARGETS) {
    if (opts.only && !target.label.includes(opts.only)) continue;
    try {
      const { ok, running } = await alreadyDoneToday(env, target, today);
      if (running) {
        out.push(target.label + ': 正在跑（run ' + running.id + '），不处理');
        continue;
      }
      if (ok && !opts.force) {
        out.push(target.label + ': 今天已成功（run ' + ok.id + '），无需触发');
        continue;
      }
      if (opts.dry) {
        out.push(target.label + ': 今天还没成功（dry，未触发）');
        continue;
      }
      await dispatch(env, target);
      out.push(target.label + ': 已 dispatch');
    } catch (e) {
      out.push(target.label + ': 出错 ' + (e && e.message ? e.message : e));
    }
  }
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const out = await runAll(env, {});
      console.log('[run ' + beijingDate() + '] ' + out.join(' | '));
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const opts = {
      dry: url.searchParams.get('dry') === '1',
      force: url.searchParams.get('force') === '1',
      only: url.searchParams.get('only') || '',
    };
    if (url.pathname !== '/' && url.pathname !== '/run') {
      return new Response('GET / 或 /run?dry=1|force=1|only=kg', { status: 200 });
    }
    const out = await runAll(env, opts);
    return new Response(out.join('\n') + '\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
