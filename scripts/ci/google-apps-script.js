/**
 * Google Apps Script 版外部兜底调度器（无需服务器、无需信用卡）
 *
 * 部署：
 *  1. https://script.google.com → 新建项目
 *  2. 把这个文件全部粘进去
 *  3. 项目设置 → 脚本属性 → 新增 GH_TOKEN = <fine-grained PAT，Actions: write>
 *  4. 编辑器里选 installTrigger 运行一次（授权）→ 之后每 30 分钟自动跑
 *  5. 想手动看一次：选 checkAll 运行，日志在「执行记录」里
 */

var TARGETS = [
  { label: 'rewards-daily', repo: 'LAIXINQUAN/Microsoft-Rewards-Script', workflow: '420202401', ref: 'V4-china' },
  { label: 'kgcheckin-签到', repo: 'LAIXINQUAN/kgcheckin', workflow: '372755970', ref: 'main' },
];

function beijingDate(d) {
  d = d || new Date();
  return Utilities.formatDate(d, 'Asia/Shanghai', 'yyyy-MM-dd');
}

function api(pathname, options) {
  options = options || {};
  var token = PropertiesService.getScriptProperties().getProperty('GH_TOKEN');
  if (!token) throw new Error('没配 GH_TOKEN 脚本属性');
  var params = {
    method: options.method || 'get',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rewards-dispatcher-gas',
    },
    muteHttpExceptions: true,
  };
  if (options.body) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(options.body);
  }
  var res = UrlFetchApp.fetch('https://api.github.com' + pathname, params);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error('HTTP ' + code + ' ' + pathname + ' -> ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

// gate 跳过的 run 也是 conclusion=success，必须下钻到 job 级别确认真的签到成功过
function reallySucceeded(run) {
  var jobs = api('/repos/' + run.repository.full_name + '/actions/runs/' + run.id + '/jobs');
  var list = (jobs && jobs.jobs) || [];
  for (var i = 0; i < list.length; i++) {
    var j = list[i];
    if (j.conclusion === 'success' && /执行签到|签到|run/i.test(j.name)) return true;
  }
  return false;
}

function alreadyDoneToday(target, today) {
  var data = api('/repos/' + target.repo + '/actions/workflows/' + target.workflow + '/runs?per_page=60');
  var runs = (data && data.workflow_runs) || [];
  var todays = runs.filter(function (r) {
    return beijingDate(new Date(r.created_at)) === today;
  });
  for (var i = 0; i < todays.length; i++) {
    var s = todays[i].status;
    if (s === 'in_progress' || s === 'queued') return { running: todays[i], ok: null };
  }
  var candidates = todays.filter(function (r) { return r.conclusion === 'success'; }).slice(0, 3);
  for (var k = 0; k < candidates.length; k++) {
    if (reallySucceeded(candidates[k])) return { running: null, ok: candidates[k] };
  }
  return { running: null, ok: null };
}

function checkAll() {
  var today = beijingDate();
  var out = [];
  for (var i = 0; i < TARGETS.length; i++) {
    var target = TARGETS[i];
    try {
      var r = alreadyDoneToday(target, today);
      if (r.running) { out.push(target.label + ': 正在跑（run ' + r.running.id + '），不处理'); continue; }
      if (r.ok) { out.push(target.label + ': 今天已成功（run ' + r.ok.id + '），无需触发'); continue; }
      api('/repos/' + target.repo + '/actions/workflows/' + target.workflow + '/dispatches', {
        method: 'post',
        body: { ref: target.ref },
      });
      out.push(target.label + ': 今天还没成功 → 已 dispatch');
    } catch (e) {
      out.push(target.label + ': 出错 ' + (e && e.message ? e.message : e));
    }
  }
  var msg = '[' + today + '] ' + out.join(' | ');
  Logger.log(msg);
  return msg;
}

function installTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkAll') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('checkAll').timeBased().everyMinutes(30).create();
  Logger.log('已安装 30 分钟触发器');
}
