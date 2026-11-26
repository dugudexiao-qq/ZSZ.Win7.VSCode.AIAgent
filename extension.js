'use strict';

/* ZSZ.Win7.VSCode.AIAgent - author: dugudexiao */

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const manifest = require('./package.json');
const runtime = require('./src/runtime');
const { ChatViewProvider } = require('./src/chatView');
const { checkConnection } = require('./src/llmClient');
const fileImport = require('./src/fileImport');
const rules = require('./src/rules');
const lessonsLib = require('./src/lessons');
const endpoint = require('./src/endpoint');
const settingsAudit = require('./src/settingsAudit');
const rulePicker = require('./src/rulePicker');
const schedulerLib = require('./src/scheduler');

const APP = manifest.displayName;
const EXT_ID = manifest.publisher + '.' + manifest.name;
let provider = null;
/* 定时任务只有一个计时器（见 armSchedules）；deactivate 时要清掉。 */
let scheduleTimer = null;
/* 测试钩子：冒烟测试要真的排一次计时器并让它到点，否则「定时」只能靠读源码
 * 断言。只暴露排程函数，不暴露数据。 */
const testHooks = { armSchedules: null, scheduleTick: null };

/* Inspect installed extensions for anything that can collide with ours:
 * duplicate copies of this extension, other publishers reusing win7Agent.*
 * settings, or other extensions registering our command IDs. */
function scanExtensionConflicts() {
  const lines = [];
  let all = [];
  try { all = (vscode.extensions && vscode.extensions.all) || []; }
  catch (e) { return ['无法读取已安装扩展列表：' + e.message]; }

  const selfId = EXT_ID.toLowerCase();
  const mine = all.filter(function (ext) {
    return String(ext.id).toLowerCase() === selfId;
  });
  lines.push('本扩展已安装副本数：' + mine.length +
    (mine.length > 1 ? ' —— 警告：存在重复副本，请卸载旧版本！' : '（正常）'));
  mine.forEach(function (ext) {
    lines.push('  · ' + ext.id + ' v' + (ext.packageJSON && ext.packageJSON.version) +
      ' @ ' + ext.extensionPath);
  });

  const ourCommands = manifest.contributes.commands.map(function (c) { return c.command; });
  const ourSettings = Object.keys(manifest.contributes.configuration.properties);
  const suspects = [];

  all.forEach(function (ext) {
    const id = String(ext.id || '');
    if (id.toLowerCase() === selfId) { return; }
    const pj = ext.packageJSON || {};
    const conf = pj.contributes && pj.contributes.configuration;
    const props = conf && conf.properties ? Object.keys(conf.properties) : [];
    const cmds = (pj.contributes && pj.contributes.commands || []).map(function (c) { return c.command; });

    const sharedSettings = props.filter(function (k) { return ourSettings.indexOf(k) !== -1; });
    const sharedCommands = cmds.filter(function (k) { return ourCommands.indexOf(k) !== -1; });
    const agentLike = /agent|ai\s?assistant|copilot|codegpt|通义|智谱|豆包|文心/i.test(id + ' ' + (pj.displayName || ''));
    if (sharedSettings.length || sharedCommands.length || agentLike) {
      suspects.push({
        id: id,
        displayName: pj.displayName || '',
        sharedSettings: sharedSettings,
        sharedCommands: sharedCommands,
        agentLike: agentLike
      });
    }
  });

  if (!suspects.length) {
    lines.push('未发现其他 AI 类扩展或设置/命令 ID 冲突。');
  } else {
    lines.push('其他值得注意的扩展（共 ' + suspects.length + ' 个）：');
    suspects.forEach(function (s) {
      let note = '  · ' + s.id + (s.displayName ? '（' + s.displayName + '）' : '');
      if (s.agentLike) { note += ' [AI 类扩展]'; }
      if (s.sharedSettings.length) { note += ' ⚠ 占用相同设置键：' + s.sharedSettings.join('、'); }
      if (s.sharedCommands.length) { note += ' ⚠ 占用相同命令 ID：' + s.sharedCommands.join('、'); }
      lines.push(note);
    });
    lines.push('说明：仅名称含 agent/AI 属于正常共存；只有当"占用相同设置键/命令 ID"出现时才是真冲突。');
  }
  return lines;
}

/* 启动时的设置体检。只提醒、不擅自改：除了明确废弃的键（allowWrite，由
 * migrateLegacyWriteSwitch 处理），其余一律要用户点一下才清。 */
function checkStaleSettings(ctx) {
  let r;
  try {
    r = settingsAudit.audit(ctx);
  } catch (e) {
    runtime.log('settings audit skipped: ' + (e && e.message ? e.message : e));
    return;
  }
  if (!settingsAudit.hasIssues(r)) { return; }
  runtime.log('settings audit: retired=' + r.retired.length + ' unknown=' + r.unknown.length +
    ' legacyDefault=' + r.legacy.length + ' otherVersions=' + r.siblings.map(function (s) { return s.version; }).join(','));
  /* 一个版本只提醒一次，避免每次启动都弹。 */
  const ackKey = 'settingsAuditAck';
  if (ctx.globalState.get(ackKey) === runtime.getExtensionInfo().version) { return; }
  const bits = [];
  if (r.retired.length) { bits.push(r.retired.length + ' 项已废弃'); }
  if (r.unknown.length) { bits.push(r.unknown.length + ' 项本版本不认识'); }
  if (r.legacy.length) { bits.push(r.legacy.length + ' 项仍是旧版默认值'); }
  if (r.siblings.length) { bits.push(r.siblings.length + ' 个旧版本还留在扩展目录'); }
  vscode.window.showWarningMessage(
    APP + '：设置里有旧版本残留（' + bits.join('，') + '），可能压住新版默认值。',
    '查看报告', '清理废弃/无效键', '忽略'
  ).then(async function (pick) {
    if (pick === '清理废弃/无效键') {
      const res = await settingsAudit.cleanup(ctx, { unknown: true });
      await ctx.globalState.update(ackKey, runtime.getExtensionInfo().version);
      vscode.window.showInformationMessage(APP + '：已清理 ' + res.removed.length + ' 项' +
        (res.failed.length ? '，失败 ' + res.failed.length + ' 项（详见输出面板）' : '') + '。');
      res.failed.forEach(function (line) { runtime.log('settings cleanup failed: ' + line); });
      return;
    }
    if (pick === '查看报告') { await settingsAudit.showReport(ctx); return; }
    await ctx.globalState.update(ackKey, runtime.getExtensionInfo().version);
  });
}

function activate(context) {
  runtime.initRuntime(context);
  const info = runtime.getExtensionInfo();
  runtime.log(info.name + ' v' + info.version + ' by ' + info.author);
  runtime.log('Target: ' + info.target + ' | running VS Code ' + vscode.version + ' / Node ' + process.versions.node);

  /* win7Agent.allowWrite 已废弃（写入只由 readOnly + deniedTools 决定）。
   * 升级时把旧键清掉，并补上 readOnly，防止原来被旧开关挡住的人突然能写盘。 */
  runtime.migrateLegacyWriteSwitch()
    .then(function (changed) {
      if (changed) { runtime.log('retired the legacy win7Agent.allowWrite setting'); }
    })
    .catch(function (e) {
      runtime.log('legacy allowWrite migration skipped: ' + (e && e.message ? e.message : e));
    });

  provider = new ChatViewProvider(context.extensionUri);
  function refresh() { return provider.postState(); }

  /* 换文件夹 / 多根工作区增删后，@ 的文件清单必须重算。 */
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(function () {
      provider.invalidateFileIndex();
    })
  );

  /* ---- 定时任务（v1.12.0） ----
   * 内网算力紧张时，把跑批的任务排到夜里。全局只有一个计时器，指向最近的
   * 触发点；到点后重新排下一次。任务存在 globalState，扩展重载不会丢；
   * 但计时器只能活在扩展宿主里 —— VS Code 关着的时候到点不会执行，
   * 这一点在命令提示和 README 里都写明。 */
  const SCHEDULE_MAX_WAIT = 60 * 1000;

  function armSchedules() {
    if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
    const now = Date.now();
    const jobs = runtime.getSchedules();
    const plan = schedulerLib.plan(jobs, now, schedulerLib.GRACE_MS);
    /* 已经有到期的（比如刚启动时发现凌晨的任务错过了）：立刻处理一次，
     * 否则 nextWakeup 会返回 null，错过的任务永远没人管。 */
    if (plan.run.length + plan.drop.length + plan.advance.length) {
      scheduleTimer = setTimeout(scheduleTick, 300);
      return;
    }
    const next = schedulerLib.nextWakeup(jobs, now);
    if (next === null) { return; }
    /* 60 秒上限：系统休眠/改时钟后 setTimeout 可能整段跳过，分段重排更稳。 */
    scheduleTimer = setTimeout(scheduleTick, Math.min(Math.max(next - now, 300), SCHEDULE_MAX_WAIT));
  }

  async function scheduleTick() {
    scheduleTimer = null;
    const now = Date.now();
    const jobs = runtime.getSchedules();
    const plan = schedulerLib.plan(jobs, now, schedulerLib.GRACE_MS);
    let dirty = false;
    const skipped = [];

    plan.drop.forEach(function (job) {
      const i = jobs.findIndex(function (x) { return x.id === job.id; });
      if (i >= 0) { jobs.splice(i, 1); dirty = true; }
      skipped.push(schedulerLib.fmtClock(job.at) + ' 的一次性任务');
      runtime.log('scheduled job expired (missed while VS Code was closed): ' + job.id);
    });
    plan.advance.forEach(function (job) {
      const i = jobs.findIndex(function (x) { return x.id === job.id; });
      if (i < 0) { return; }
      const nextAt = schedulerLib.advance(jobs[i], now);
      if (!nextAt) { jobs.splice(i, 1); }
      dirty = true;
      skipped.push(schedulerLib.fmtClock(job.at) + ' 的每天任务');
    });
    if (skipped.length) {
      provider.notify('[定时] 错过了 ' + skipped.join('、') + '（当时 VS Code 没在运行），已跳过');
    }

    const firing = plan.run.slice();
    firing.forEach(function (job) {
      const i = jobs.findIndex(function (x) { return x.id === job.id; });
      if (i < 0) { return; }
      jobs[i].lastRunAt = now;
      jobs[i].lastResult = 'fired';
      if (jobs[i].kind === schedulerLib.DAILY) {
        if (!schedulerLib.advance(jobs[i], now)) { jobs.splice(i, 1); }
      } else {
        jobs.splice(i, 1);
      }
      dirty = true;
    });
    if (dirty) { await runtime.saveSchedules(jobs); }

    firing.forEach(function (job) {
      runtime.log('scheduled job fired: ' + job.id + ' (' + schedulerLib.fmtClock(job.at) + ')');
      /* runScheduled 内部已经把失败转成 error 事件，但仍要接住 Promise：
       * 未处理的 rejection 在 Node 16 会直接打印堆栈甚至终止扩展宿主。 */
      Promise.resolve(provider.runScheduled(job.text, { at: job.at })).catch(function (e) {
        runtime.log('scheduled job failed to start: ' + job.id + ' ' +
          (e && e.message ? e.message : e));
      });
    });

    armSchedules();
  }

  async function pickScheduleTime(now) {
    const clockOf = function (ms) { return schedulerLib.fmtClock(ms); };
    const items = [
      { label: '$(watch) 30 分钟后', description: clockOf(now + 30 * 60000), at: now + 30 * 60000 },
      { label: '$(watch) 1 小时后', description: clockOf(now + 60 * 60000), at: now + 60 * 60000 },
      { label: '$(watch) 2 小时后', description: clockOf(now + 120 * 60000), at: now + 120 * 60000 },
      { label: '$(calendar) 凌晨 02:00（错峰）', description: schedulerLib.describeAt(schedulerLib.nextDailyAt('02:00', now), now), clock: '02:00' },
      { label: '$(edit) 指定时刻…', description: '输入 HH:MM，例如 23:30', custom: true }
    ];
    return vscode.window.showQuickPick(items, {
      placeHolder: '什么时候执行？定时器只在 VS Code 运行期间有效'
    });
  }

  async function scheduleTask(arg) {
    const draft = arg && typeof arg === 'object' ? String(arg.text || '') : String(arg || '');
    let text = draft.trim();
    if (!text) {
      const typed = await vscode.window.showInputBox({
        prompt: '定时执行的任务（写成一句完整的话，到点会原样发给 Agent）',
        placeHolder: '例如：把 docs 下所有 markdown 的链接检查一遍，汇总失效链接'
      });
      if (typed === undefined) { return; }
      text = typed.trim();
    }
    if (!text) {
      vscode.window.showWarningMessage(APP + ': 任务是空的。先在对话输入框写好内容，再从菜单选「定时发送…」。');
      return;
    }

    const now = Date.now();
    const pick = await pickScheduleTime(now);
    if (!pick) { return; }

    let clock = pick.clock || '';
    if (pick.custom) {
      const typed = await vscode.window.showInputBox({
        prompt: '几点执行？24 小时制，例如 02:00 / 23:30',
        value: '02:00',
        placeHolder: 'HH:MM',
        validateInput: function (v) {
          return schedulerLib.parseClock(v) ? '' : '请输入 0-23 时、0-59 分，例如 02:00';
        }
      });
      if (typed === undefined) { return; }
      clock = typed.trim();
    }

    let kind = schedulerLib.ONCE;
    let at = pick.at || 0;
    let time = '';
    if (clock) {
      const repeat = await vscode.window.showQuickPick([
        { label: '$(history) 每天这个时间', description: '内网错峰跑批的常规用法', value: schedulerLib.DAILY },
        { label: '$(clock) 只跑这一次', description: '跑完自动失效', value: schedulerLib.ONCE }
      ], { placeHolder: '重复方式' });
      if (!repeat) { return; }
      kind = repeat.value;
      at = kind === schedulerLib.DAILY
        ? schedulerLib.nextDailyAt(clock, now)
        : schedulerLib.clockOnDay(clock, now);
      /* 一次性任务写的是「今天 02:00」，但现在已经是下午：落到明天，
       * 否则建完就是一条已经过期的任务。 */
      if (kind === schedulerLib.ONCE && at <= now) { at = schedulerLib.nextDailyAt(clock, now); }
      time = clock;
    }

    const jobs = runtime.getSchedules();
    if (jobs.length >= schedulerLib.MAX_JOBS) {
      vscode.window.showWarningMessage(APP + ': 定时任务最多 ' + schedulerLib.MAX_JOBS +
        ' 条，先在「定时任务：管理」里删掉一些。');
      return;
    }
    const job = schedulerLib.normalizeJob({
      text: text, kind: kind, at: at, time: time, createdAt: now
    }, now);
    if (!job) {
      vscode.window.showWarningMessage(APP + ': 这个时间无效，任务没有创建。');
      return;
    }
    jobs.push(job);
    const saved = await runtime.saveSchedules(jobs);
    armSchedules();
    if (!saved) {
      vscode.window.showErrorMessage(APP + ': 定时任务没能写入 globalState，重启后会丢失。');
      return;
    }
    runtime.log('scheduled job created: ' + job.id + ' at ' + new Date(job.at).toISOString() + ' kind=' + job.kind);
    /* 面板里的草稿已经变成定时任务，输入框清空，免得下次手滑再发一遍。 */
    if (draft.trim()) { provider.prefill(''); }
    vscode.window.showInformationMessage(APP + ': 已排定「' + schedulerLib.shortText(text, 20) + '」— ' +
      schedulerLib.describe(job, Date.now()) + '。到点前请保持 VS Code 开着。');
  }

  async function manageSchedules() {
    const now = Date.now();
    const jobs = runtime.getSchedules();
    if (!jobs.length) {
      const add = await vscode.window.showInformationMessage(
        APP + ': 还没有定时任务。先把任务写在对话输入框，再从 「···」菜单选「定时发送…」。',
        '立即新建', '取消');
      if (add === '立即新建') { await vscode.commands.executeCommand('win7Agent.scheduleTask'); }
      return;
    }
    const items = jobs.map(function (job) {
      return {
        label: (job.enabled === false ? '$(circle-slash) ' : '$(clock) ') + schedulerLib.describeAt(job.at, now) +
          ' · ' + schedulerLib.shortText(job.text, 26),
        description: schedulerLib.describe(job, now),
        detail: job.text.slice(0, 200),
        jobId: job.id
      };
    });
    items.push({ label: '$(add) 新建定时任务…', action: 'add' });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: '定时任务：' + jobs.length + ' 条｜选中可立即执行 / 暂停 / 删除',
      matchOnDescription: true
    });
    if (!pick) { return; }
    if (pick.action === 'add') {
      await vscode.commands.executeCommand('win7Agent.scheduleTask');
      return;
    }
    const job = jobs.filter(function (j) { return j.id === pick.jobId; })[0];
    if (!job) { return; }
    const actions = [
      { label: '$(play) 立即执行一次', action: 'run' },
      { label: (job.enabled === false ? '$(debug-start) 恢复定时' : '$(debug-pause) 暂停定时'), action: 'toggle' },
      { label: '$(trash) 删除这条定时任务', action: 'delete' }
    ];
    const act = await vscode.window.showQuickPick(actions, {
      placeHolder: schedulerLib.shortText(job.text, 40) + '｜' + schedulerLib.describe(job, now)
    });
    if (!act) { return; }
    if (act.action === 'run') {
      job.lastRunAt = now;
      job.lastResult = 'manual';
      await runtime.saveSchedules(jobs);
      provider.runScheduled(job.text, { at: now });
      vscode.window.showInformationMessage(APP + ': 已立即执行「' + schedulerLib.shortText(job.text, 20) + '」。');
      return;
    }
    if (act.action === 'toggle') {
      job.enabled = job.enabled === false;
      if (job.enabled && job.kind === schedulerLib.DAILY) {
        schedulerLib.advance(job, now);
      }
      await runtime.saveSchedules(jobs);
      armSchedules();
      vscode.window.showInformationMessage(APP + ': 「' + schedulerLib.shortText(job.text, 20) + '」' +
        (job.enabled ? '已恢复定时：' + schedulerLib.describe(job, Date.now()) : '已暂停。'));
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      '删除这条定时任务？\n「' + schedulerLib.shortText(job.text, 60) + '」', { modal: true }, '删除');
    if (answer !== '删除') { return; }
    await runtime.saveSchedules(jobs.filter(function (j) { return j.id !== job.id; }));
    armSchedules();
    vscode.window.showInformationMessage(APP + ': 定时任务已删除。');
  }

  /* 设置体检：同一个扩展 ID 装过多个版本、或曾经装过同名增强版时，旧版的键会
   * 一直躺在 settings.json 里；更隐蔽的是旧版内置默认值被写进用户设置，长期压住
   * 新版默认值。启动时查一次，只在发现新情况时提醒一次（按版本记，不反复打扰）。 */
  checkStaleSettings(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'win7Agent.chatView',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.openChat', function () {
      return vscode.commands.executeCommand('win7Agent.chatView.focus');
    })
  );

  /* ---- write mode: one switch for the three gates on insertText/saveText ---- */

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.toggleWriteMode', async function () {
      const enabled = runtime.isWriteMode();
      if (!enabled) {
        const answer = await vscode.window.showWarningMessage(
          '启用写入模式后，Agent 可以修改工作区文件（insertText / saveText）。' +
          '是否逐次弹窗由「写入确认」开关决定（默认开，可在菜单关闭），且只能写工作区内、匹配 allowedReadGlobs 的路径。确定启用？',
          { modal: true },
          '启用写入'
        );
        if (answer !== '启用写入') { return; }
      } else {
        const answer = await vscode.window.showInformationMessage(
          '当前处于写入模式（Agent 可改文件）。要关闭并回到只读吗？',
          { modal: true },
          '关闭写入'
        );
        if (answer !== '关闭写入') { return; }
      }
      try {
        const nowOn = await runtime.setWriteMode(!enabled);
        await refresh();
        runtime.log('write mode -> ' + (nowOn ? 'ON' : 'OFF') + ' (readOnly=' + (!nowOn) + ')');
        vscode.window.showInformationMessage(
          APP + (nowOn ? ': 写入模式已开启（是否弹窗由「写入确认」开关决定）。'
                       : ': 已回到只读模式，Agent 不能再改文件。')
        );
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        runtime.log('failed to toggle write mode: ' + msg);
        vscode.window.showErrorMessage(APP + ': 切换写入模式失败（' + msg + '），请手动编辑 settings.json。');
      }
    })
  );

  /* ---- shell confirmation: user-facing switch for confirmShell ---- */

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.toggleShellConfirm', async function () {
      const enabled = runtime.isShellConfirm();
      if (enabled) {
        const answer = await vscode.window.showWarningMessage(
          '关闭"命令确认"后，Agent 提议的 PowerShell / CMD 命令将不再弹窗、直接运行。' +
          '这会降低安全性，请只在可信环境和可信模型下使用。确定关闭确认吗？',
          { modal: true },
          '关闭确认',
          '保持开启'
        );
        if (answer !== '关闭确认') { return; }
      } else {
        const answer = await vscode.window.showInformationMessage(
          '当前"命令确认"已关闭（命令直接运行）。要重新开启逐条确认吗？',
          { modal: true },
          '开启确认'
        );
        if (answer !== '开启确认') { return; }
      }
      try {
        const nowOn = await runtime.setShellConfirm(!enabled);
        await refresh();
        runtime.log('shell confirmation -> ' + (nowOn ? 'ON' : 'OFF'));
        const extra = (!nowOn && runtime.getConfig().constraints.requireToolApproval)
          ? ' 注意：「每次工具调用都确认」(constraints.requireToolApproval) 仍开启，工具调用仍会弹窗——那是另一道关卡。'
          : (!nowOn ? ' 如仍弹窗，请用「查看生效提示词与约束」检查是否有工作区设置覆盖。' : '');
        vscode.window.showInformationMessage(
          APP + (nowOn ? ': 命令确认已开启（每条命令执行前会弹窗）。'
                       : ': 命令确认已关闭，命令将直接运行，请注意安全。' + extra)
        );
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        runtime.log('failed to toggle shell confirmation: ' + msg);
        vscode.window.showErrorMessage(APP + ': 切换命令确认失败（' + msg + '），请手动编辑 settings.json。');
      }
    })
  );

  /* ---- write confirmation: user-facing switch for confirmWrite ---- */

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.toggleWriteConfirm', async function () {
      const enabled = runtime.isWriteConfirm();
      if (enabled) {
        const answer = await vscode.window.showWarningMessage(
          '关闭"写入确认"后，Agent 新建/改写文件（createFile / saveText / 插入）将不再弹窗、直接写入。' +
          '写入模式本身仍须开启，且只能写工作区内路径。请只在可信模型下关闭。确定关闭确认吗？',
          { modal: true },
          '关闭确认',
          '保持开启'
        );
        if (answer !== '关闭确认') { return; }
      } else {
        const answer = await vscode.window.showInformationMessage(
          '当前"写入确认"已关闭（写入直接生效）。要重新开启逐条确认吗？',
          { modal: true },
          '开启确认'
        );
        if (answer !== '开启确认') { return; }
      }
      try {
        const nowOn = await runtime.setWriteConfirm(!enabled);
        await refresh();
        runtime.log('write confirmation -> ' + (nowOn ? 'ON' : 'OFF'));
        const extra = (!nowOn && runtime.getConfig().constraints.requireToolApproval)
          ? ' 注意：「每次工具调用都确认」仍开启，写入仍会先弹工具审批。'
          : (!nowOn ? ' 如仍弹窗，请检查工作区设置是否覆盖，或是否开着「每次工具调用都确认」。' : '');
        vscode.window.showInformationMessage(
          APP + (nowOn ? ': 写入确认已开启（每次写入前会弹窗）。'
                       : ': 写入确认已关闭，写入将直接生效，请注意安全。' + extra)
        );
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        runtime.log('failed to toggle write confirmation: ' + msg);
        vscode.window.showErrorMessage(APP + ': 切换写入确认失败（' + msg + '），请手动编辑 settings.json。');
      }
    })
  );

  /* ---- subtask mode: delegate independent work to bounded sub-agents ---- */

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.toggleSubtaskMode', async function () {
      const enabled = runtime.isSubtaskMode();
      if (enabled) {
        const answer = await vscode.window.showInformationMessage(
          '当前子任务模式已开启：Agent 可把独立子任务交给子代理执行（有数量与嵌套上限）。要关闭吗？',
          { modal: true },
          '关闭子任务'
        );
        if (answer !== '关闭子任务') { return; }
      } else {
        const answer = await vscode.window.showInformationMessage(
          '开启子任务模式后，复杂任务可拆成子任务逐项执行，过程会显示在对话区。确定开启？',
          { modal: true },
          '开启子任务'
        );
        if (answer !== '开启子任务') { return; }
      }
      try {
        const nowOn = await runtime.setSubtaskMode(!enabled);
        await refresh();
        runtime.log('subtask mode -> ' + (nowOn ? 'ON' : 'OFF'));
        vscode.window.showInformationMessage(
          APP + (nowOn ? ': 子任务模式已开启。' : ': 子任务模式已关闭，runSubtask 将被拦截。')
        );
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        runtime.log('failed to toggle subtask mode: ' + msg);
        vscode.window.showErrorMessage(APP + ': 切换子任务模式失败（' + msg + '）。');
      }
    })
  );

  /* ---- editor-area panel: chat side-by-side with the file explorer ---- */

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.openChatPanel', function () {
      provider.showEditorPanel();
    })
  );

  /* ---- endpoint / port: works even when the Settings UI shows no settings ---- */

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.setEndpoint', async function () {
      const current = runtime.getConfig().baseUrl;
      const input = await vscode.window.showInputBox({
        prompt: current
          ? '模型服务地址。可填完整 URL、主机:端口，或只填端口号（沿用当前地址 ' + current + '）。'
          : '模型服务地址。本扩展不内置地址或端口，请填写完整地址，例如 http://主机:端口/v1',
        value: current,
        placeHolder: current ? current : 'http://主机:端口/v1',
        validateInput: function (text) {
          const r = endpoint.normalizeEndpoint(text, current);
          return r.ok ? null : r.error;
        }
      });
      if (input === undefined) { return; }
      const result = endpoint.normalizeEndpoint(input, current);
      if (!result.ok) {
        vscode.window.showErrorMessage(APP + ': ' + result.error);
        return;
      }
      try {
        await vscode.workspace.getConfiguration('win7Agent').update(
          'baseUrl', result.value, vscode.ConfigurationTarget.Global);
        await refresh();
        runtime.log('endpoint -> ' + result.value + (result.note ? ' (' + result.note + ')' : ''));
        const choice = await vscode.window.showInformationMessage(
          APP + ': 服务地址已设为 ' + result.value + '（端口 ' + result.port + '）。' +
            (result.note ? ' ' + result.note + '。' : ''),
          '诊断连接 (Diagnose Connection)'
        );
        if (choice === '诊断连接 (Diagnose Connection)') {
          await vscode.commands.executeCommand('win7Agent.diagnose');
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        runtime.log('failed to write baseUrl into user settings: ' + msg);
        vscode.window.showErrorMessage(
          APP + ': 写入设置失败（' + msg + '）。请手动编辑 settings.json：运行 ' +
          'Preferences: Open User Settings (JSON)，加入 "win7Agent.baseUrl": "' + result.value + '"'
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.openSettingsJson', function () {
      return vscode.commands.executeCommand('workbench.action.openSettingsJson');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.setApiKey', async function () {
      const key = await vscode.window.showInputBox({
        prompt: 'API key（本地 llama.cpp / Ollama / LM Studio 服务可留空）。保存在 VS Code SecretStorage。',
        placeHolder: 'sk-...（本地模型服务请留空）',
        password: true
      });
      if (key === undefined) { return; }
      const trimmed = key.trim();
      if (!trimmed) { return; }
      const persisted = await runtime.setApiKey(trimmed);
      await refresh();
      vscode.window.showInformationMessage(
        persisted
          ? APP + ': API key 已保存到 SecretStorage。'
          : APP + ': SecretStorage 不可用，key 仅在本次会话中保存在内存。'
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.clearApiKey', async function () {
      await runtime.clearApiKey();
      await refresh();
      vscode.window.showInformationMessage(APP + ': API key 已清除。');
    })
  );

  /* ---- named model profiles: several endpoint/model/key combos, one-click switch ----
   * 离线机常见「本地小模型 + 内网大模型」两套配置，逐项手改太繁琐。这里把
   * 当前配置存成命名 profile，菜单里一键切回。key 随 profile 存本机 globalState。 */
  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.switchProfile', async function () {
      const profiles = runtime.getProfiles();
      const activeName = runtime.activeProfileName();
      const config = runtime.getConfig();
      const items = profiles.map(function (p) {
        const isActive = p.name === activeName;
        return {
          label: (isActive ? '$(check) ' : '$(plug) ') + p.name,
          description: p.baseUrl + ' / ' + (p.model || '(默认模型)') + (isActive ? ' · 当前' : ''),
          action: 'switch', name: p.name
        };
      });
      if (!profiles.length) {
        items.push({ label: '$(info) 还没有保存的配置', description: '先把当前的服务地址/模型存为第一份配置', action: 'noop' });
      }
      items.push({ label: '$(add) 把当前配置存为新配置…', description: config.baseUrl + ' / ' + config.model, action: 'add' });
      if (profiles.length) {
        items.push({ label: '$(trash) 删除一个配置…', description: '删除后不影响当前生效的连接', action: 'del' });
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: '模型配置 ' + profiles.length + '/' + 8 + '｜当前：' + (activeName || '自定义（未匹配任何配置）')
      });
      if (!pick) { return; }
      if (pick.action === 'switch') {
        const target = profiles.find(function (p) { return p.name === pick.name; });
        if (!target) { return; }
        try {
          await runtime.applyProfile(target);
          await refresh();
          vscode.window.showInformationMessage(APP + ': 已切换到配置「' + target.name + '」（' +
            target.baseUrl + ' / ' + target.model + '）。', '诊断连接')
            .then(function (choice) {
              if (choice === '诊断连接') { vscode.commands.executeCommand('win7Agent.diagnose'); }
            });
        } catch (e) {
          vscode.window.showErrorMessage(APP + ': 切换配置失败（' + (e && e.message ? e.message : e) + '）');
        }
      } else if (pick.action === 'add') {
        await nextTick();
        const name = await vscode.window.showInputBox({
          prompt: '给当前配置起个名字（例如：本地 llama / 内网大模型）',
          placeHolder: '配置名'
        });
        if (name === undefined) { return; }
        const key = await runtime.getApiKey();
        const result = await runtime.addProfile(name, config.baseUrl, config.model, key || '');
        await refresh();
        if (result.ok) {
          vscode.window.showInformationMessage(APP + ': 已保存配置「' + String(name).trim() + '」，之后可在本菜单一键切换。');
        } else {
          vscode.window.showWarningMessage(APP + ': ' + result.message);
        }
      } else if (pick.action === 'del') {
        const delItems = profiles.map(function (p) {
          return { label: p.name, description: p.baseUrl + ' / ' + p.model };
        });
        const victim = await vscode.window.showQuickPick(delItems, { placeHolder: '选择要删除的配置' });
        if (!victim) { return; }
        const answer = await vscode.window.showWarningMessage('删除配置「' + victim.label + '」？', { modal: true }, '删除');
        if (answer !== '删除') { return; }
        const result = await runtime.deleteProfile(victim.label);
        await refresh();
        vscode.window.showInformationMessage(APP + (result.ok ? ': 已删除。' : ': ' + result.message));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.askSelection', async function () {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage(APP + ': 请先选中一段代码。');
        return;
      }
      const text = editor.document.getText(editor.selection);
      if (!text.trim()) { return; }
      const lang = editor.document.languageId || 'text';
      const prompt = '请用中文解释以下 ' + lang + ' 代码：\n\n```' + lang + '\n' + text + '\n```';
      provider.prefill(prompt);
      await vscode.commands.executeCommand('win7Agent.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.about', function () {
      const about = runtime.getExtensionInfo();
      const config = runtime.getConfig();
      const summary = runtime.getRuleSummary();
      runtime.log('--- about ---');
      runtime.log('Name      : ' + about.name);
      runtime.log('Author    : ' + about.author);
      runtime.log('Extension : ' + about.id + ' v' + about.version);
      runtime.log('License   : ' + about.license);
      runtime.log('Target    : ' + about.target);
      runtime.log('VS Code   : ' + vscode.version + ' / Node ' + process.versions.node);
      runtime.log('Endpoint  : ' + config.baseUrl);
      runtime.log('Model     : ' + config.model);
      runtime.log('Timeout   : ' + config.timeoutMs + ' ms');
      runtime.log('Rules     : ' + summary.defaultCount + ' default + ' + summary.memoryCount + ' remembered');
      runtime.log('Read-only : ' + config.constraints.readOnly + ' | Shell: ' + config.constraints.allowShell);
      runtime.log('--- end ---');
      return vscode.window.showInformationMessage(
        APP + ' v' + about.version + ' © ' + about.year + ' ' + about.author + ' (MIT License) - ' + about.target + '\n反馈：' + about.email,
        '在 Output 面板查看详情'
      ).then(function (choice) {
        if (choice === '在 Output 面板查看详情') { runtime.showOutput(); }
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.diagnose', async function () {
      const config = runtime.getConfig();
      const key = await runtime.getApiKey();
      const about = runtime.getExtensionInfo();
      const summary = runtime.getRuleSummary();
      runtime.showOutput();
      if (!config.baseUrl) {
        runtime.log('--- 未设置服务地址 ---');
        runtime.log('本扩展不内置地址或端口。请先运行「设置服务地址 / 端口」，填入你的模型服务完整地址（例如 http://主机:端口/v1）。');
        vscode.window.showErrorMessage(APP + ': 尚未设置模型服务地址，请先运行「设置服务地址 / 端口」。');
        return;
      }
      runtime.log('--- extension conflict scan ---');
      scanExtensionConflicts().forEach(function (line) { runtime.log(line); });
      runtime.log('--- connectivity check (15 s diagnostic timeout) ---');
      runtime.log('by       : ' + about.author + ' (v' + about.version + ')');
      runtime.log('endpoint : ' + config.baseUrl + (config.localEndpoint ? ' [local/intranet]' : ''));
      runtime.log('model    : ' + config.model);
      runtime.log('chat timeout : ' + config.timeoutMs + ' ms');
      runtime.log('rules    : ' + summary.defaultCount + ' default + ' + summary.memoryCount + ' remembered');
      runtime.log('proxy    : ' + (config.proxy || '(none)'));
      runtime.log('api key  : ' + (key ? 'present' : 'none'));
      if (!key && !config.localEndpoint) {
        runtime.log('result   : FAILED (cloud endpoint requires an API key)');
        vscode.window.showErrorMessage(APP + ': 该端点需要 API key，请先运行「设置 API Key」。');
        return;
      }
      if (!key) { runtime.log('note     : local endpoint, request will be sent without an Authorization header'); }
      const result = await checkConnection({ config: config, apiKey: key, timeoutMs: 15000 });
      runtime.log('result   : ' + (result.ok ? 'OK' : 'FAILED'));
      runtime.log('detail   : ' + result.detail);
      runtime.log('--- end ---');
      if (result.ok) {
        vscode.window.showInformationMessage(APP + ': 连接正常。' + result.detail, '导出诊断包')
          .then(function (choice) {
            if (choice === '导出诊断包') { vscode.commands.executeCommand('win7Agent.exportDiagnostics'); }
          });
      } else {
        vscode.window.showErrorMessage(APP + ': ' + result.detail, '导出诊断包')
          .then(function (choice) {
            if (choice === '导出诊断包') { vscode.commands.executeCommand('win7Agent.exportDiagnostics'); }
          });
      }
    })
  );

  /* ---- 设置体检：旧版本/同名插件留下的键，一键看清、按需清掉 ---- */

  testHooks.armSchedules = armSchedules;
  testHooks.scheduleTick = scheduleTick;

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.scheduleTask', scheduleTask)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.manageSchedules', manageSchedules)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.auditSettings', async function () {
      const r = await settingsAudit.showReport(context);
      if (!settingsAudit.hasIssues(r)) {
        vscode.window.showInformationMessage(APP + '：设置很干净，没有旧版本残留。');
        return;
      }
      const items = [];
      if (r.retired.length) {
        items.push({ label: '清理已废弃的键（' + r.retired.length + ' 项）', description: r.retired.map(function (i) { return i.key; }).join('、'), action: 'retired' });
      }
      if (r.unknown.length) {
        items.push({ label: '清理本版本不认识的键（' + r.unknown.length + ' 项）', description: r.unknown.map(function (i) { return i.key; }).join('、'), action: 'unknown' });
      }
      if (r.legacy.length) {
        items.push({ label: '删掉仍是旧版默认值的项（' + r.legacy.length + ' 项，恢复当前默认）', description: r.legacy.map(function (i) { return i.key; }).join('、'), action: 'legacy' });
      }
      if (r.siblings.length) {
        items.push({ label: '旧版本仍留在扩展目录（' + r.siblings.length + ' 个）', description: r.siblings.map(function (s) { return s.version; }).join('、') + '（VS Code 退出后手动删）', action: 'siblings' });
      }
      items.push({ label: '只看报告，不改任何东西', action: 'none' });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: '要清哪一类？清理后相关设置会回到当前版本的默认值' });
      if (!pick || pick.action === 'none') { return; }

      if (pick.action === 'siblings') {
        const list = r.siblings.map(function (s) { return s.path; }).join('\n');
        const open = await vscode.window.showWarningMessage(
          APP + '：这些旧版本目录要关掉 VS Code 之后才能删除。删之前请确认里面没有你手改过的文件。',
          '打开扩展目录', '复制路径'
        );
        if (open === '复制路径') { await vscode.env.clipboard.writeText(list); }
        if (open === '打开扩展目录') {
          await vscode.env.openExternal(vscode.Uri.file(path.dirname(r.siblings[0].path)));
        }
        return;
      }

      const res = await settingsAudit.cleanup(context, {
        retired: pick.action === 'retired',
        unknown: pick.action === 'unknown',
        legacy: pick.action === 'legacy'
      });
      res.failed.forEach(function (line) { runtime.log('settings cleanup failed: ' + line); });
      if (res.removed.length) {
        vscode.window.showInformationMessage(APP + '：已清理 ' + res.removed.length + ' 项设置' +
          (res.failed.length ? '，另有 ' + res.failed.length + ' 项失败（见输出面板）' : '') + '。');
      } else {
        vscode.window.showWarningMessage(APP + '：没有清理成功' + (res.failed.length ? '（' + res.failed[0] + '）' : '') + '。');
      }
    })
  );

  /* ---- diagnostics bundle: one file a user can send back ---- */

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.exportDiagnostics', async function () {
      const config = runtime.getConfig();
      const about = runtime.getExtensionInfo();
      const summary = runtime.getRuleSummary();
      const key = await runtime.getApiKey();
      const scopeKeys = [
        'baseUrl', 'model', 'stream', 'maxToolRounds', 'maxHistoryMessages', 'maxContextChars',
        'confirmTimeoutMs', 'taskCheck', 'subtaskMode',
        'constraints.readOnly', 'constraints.allowShell', 'constraints.confirmShell',
        'constraints.confirmWrite', 'constraints.requireToolApproval',
        'constraints.deniedTools', 'constraints.allowedReadGlobs', 'constraints.allowedShellCommands'
      ];
      const folders = vscode.workspace.workspaceFolders || [];
      const lines = [];
      lines.push('ZSZ.Win7.VSCode.AIAgent 诊断包');
      lines.push('生成时间 : ' + new Date().toISOString());
      lines.push('扩展版本 : v' + about.version + ' (' + EXT_ID + ')');
      lines.push('VS Code  : ' + vscode.version);
      lines.push('Node     : ' + process.version + ' / ' + process.platform + ' ' + process.arch);
      lines.push('工作区   : ' + (folders.length ? folders.map(function (f) { return f.uri.fsPath; }).join(' | ') : '(未打开)'));
      lines.push('');
      lines.push('--- 设置生效值（default | user | workspace | folder | effective） ---');
      scopeKeys.forEach(function (k) { lines.push(k + ': ' + runtime.describeSettingScope(k)); });
      lines.push('');
      lines.push('--- 运行态 ---');
      lines.push('endpoint : ' + (config.baseUrl || '(未设置)') + '  local=' + config.localEndpoint);
      lines.push('model    : ' + (config.model || '(未设置)'));
      lines.push('api key  : ' + (key ? 'present' : 'none'));
      lines.push('rules    : ' + summary.defaultCount + ' default + ' + summary.memoryCount + ' remembered');
      lines.push('limits   : 工具轮数 ' + config.maxToolRounds + ' / 历史 ' + config.maxHistoryMessages +
        ' 条 / 上下文 ' + config.maxContextChars + ' 字符');
      lines.push('');
      lines.push('--- 扩展冲突扫描 ---');
      scanExtensionConflicts().forEach(function (line) { lines.push(line); });
      lines.push('');
      lines.push('--- 设置体检（旧版本/同名插件残留） ---');
      try {
        settingsAudit.report(settingsAudit.audit(context)).split('\n').forEach(function (line) { lines.push(line); });
      } catch (e) {
        lines.push('体检失败：' + (e && e.message ? e.message : e));
      }
      lines.push('');
      lines.push('--- 最近日志（最多 300 行） ---');
      runtime.getLogLines(300).forEach(function (line) { lines.push(line); });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const baseDir = folders.length ? folders[0].uri.fsPath : os.tmpdir();
      const target = path.join(baseDir, 'zsz-diagnostics-' + stamp + '.txt');
      try {
        fs.writeFileSync(target, lines.join('\r\n'), 'utf8');
      } catch (e) {
        vscode.window.showErrorMessage(APP + ': 诊断包写入失败（' + (e && e.message ? e.message : e) + '）');
        return;
      }
      runtime.log('diagnostics exported: ' + target);
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        await vscode.window.showTextDocument(doc);
      } catch (e) {
        /* opening is a convenience, not the result */
      }
      vscode.window.showInformationMessage(APP + ': 诊断包已导出到 ' + target);
    })
  );

  /* ---- standing rules: defaults in settings.json + memory in globalState ---- */

  /* QuickPick 关闭到下一个输入框获得焦点之间要留一帧：命令面板/选择器收起时
   * VS Code 会先把焦点还给编辑器，紧接着打开的 InputBox 有时抢不到键盘，
   * 表现就是「框在那儿，打字/回车没反应」（1.70 这类老版本尤其明显）。 */
  function nextTick(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms === undefined ? 120 : ms); });
  }

  async function commitRule(text) {
    const result = await runtime.addMemoryRule(text);
    await refresh();
    if (result.ok) { vscode.window.showInformationMessage(APP + ': ' + result.message); }
    else { vscode.window.showWarningMessage(APP + ': ' + result.message); }
    return result;
  }

  async function promptNewRule() {
    const text = await vscode.window.showInputBox({
      prompt: '这条要求会长期记住，并在之后每次请求前注入系统提示词（存于 VS Code globalState）。',
      placeHolder: '例如：所有代码注释用中文；回答控制在 200 字以内',
      /* 不设 ignoreFocusOut：老版本里「失焦不关闭」会让框留着却不再持有键盘，
       * 看着像输入框坏了。宁可切窗口时自动取消，也不要一个假活的框。 */
      validateInput: function (value) {
        const v = String(value || '').trim();
        if (!v) { return '写点内容再回车；Esc 取消'; }
        if (v.length > 200) { return '最多 200 个字符'; }
        return null;
      }
    });
    if (text === undefined) { return; }
    await commitRule(text);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.addRule', async function () {
      await nextTick(0);
      await promptNewRule();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.manageRules', async function () {
      const memory = runtime.getMemoryRules();
      const summary = runtime.getRuleSummary();
      const endpointLabel = endpoint.shortEndpoint(runtime.getConfig().baseUrl);

      /* 用 createQuickPick 而不是 showQuickPick：选择框本身就是「输入框」，
       * 用户打完字回车必须记下这条，不能被当成过滤后选中第一条（那会误删）。 */
      const pick = await new Promise(function (resolve) {
        const qp = vscode.window.createQuickPick();
        let settled = false;
        function finish(value) {
          if (settled) { return; }
          settled = true;
          resolve(value);
          qp.hide();
        }
        qp.placeholder = rulePicker.placeholder(summary);
        qp.matchOnDescription = true;
        qp.items = rulePicker.buildItems(memory, summary, '', endpointLabel);
        qp.onDidChangeValue(function (value) {
          qp.items = rulePicker.buildItems(memory, summary, value, endpointLabel);
        });
        qp.onDidAccept(function () {
          finish(rulePicker.resolveAccept(qp.selectedItems, qp.value, memory));
        });
        qp.onDidHide(function () {
          if (!settled) { settled = true; resolve(undefined); }
          qp.dispose();
        });
        qp.show();
      });
      if (!pick) { return; }

      if (pick.kind === 'addNew') {
        await commitRule(pick.value);
      } else if (pick.kind === 'duplicate') {
        vscode.window.showInformationMessage(APP + ': 这条要求已经在记忆里了，没有重复添加。');
      } else if (pick.kind === 'rule') {
        /* 空输入时第一行就是一条规则，回车很容易误删——删之前问一句。 */
        const label = memory[pick.ruleIndex];
        const answer = await vscode.window.showWarningMessage(
          '删除这条长期要求？\n「' + label + '」', { modal: true }, '删除');
        if (answer !== '删除') { return; }
        await runtime.removeMemoryRule(pick.ruleIndex);
        await refresh();
        vscode.window.showInformationMessage(APP + ': 已删除一条记忆规则。');
      } else if (pick.action === 'add') {
        await nextTick();
        await promptNewRule();
      } else if (pick.action === 'clear') {
        const answer = await vscode.window.showWarningMessage('清空全部记忆规则？出厂默认规则会保留。', { modal: true }, '清空');
        if (answer === '清空') {
          await runtime.clearMemoryRules();
          await refresh();
          vscode.window.showInformationMessage(APP + ': 记忆规则已清空。');
        }
      } else if (pick.action === 'show') {
        await vscode.commands.executeCommand('win7Agent.showPrompt');
      } else if (pick.action === 'endpoint') {
        await nextTick();
        await vscode.commands.executeCommand('win7Agent.setEndpoint');
      } else if (pick.action === 'settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + EXT_ID + ' win7Agent');
      } else if (pick.action === 'settingsjson') {
        await vscode.commands.executeCommand('workbench.action.openSettingsJson');
      }
    })
  );

  /* ---- auto-lessons: what the agent learned from its own failures ----
   * Separate from manageRules on purpose: these notes are machine-written, so
   * they must be inspectable and deletable one by one without touching the
   * rules the user typed by hand. */
  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.manageLessons', async function () {
      const list = runtime.getLessons();
      const config = runtime.getConfig();
      const items = list.map(function (lesson, index) {
        return {
          label: lesson.text,
          description: '命中 ' + lesson.hits + ' 次' + (index === list.length - 1 ? ' · 最新' : ''),
          lessonIndex: index
        };
      });
      if (!list.length) {
        items.push({
          label: '$(info) 还没有自动经验',
          description: '工具报错之后又被修好时，解决方式会自动记成一条经验'
        });
      }
      items.push({ label: '$(trash) 清空全部经验', description: '只清自动学习，不动你手写的长期要求', action: 'clear' });
      items.push({
        label: config.autoLearn ? '$(circle-slash) 关闭自动学习' : '$(check) 开启自动学习',
        description: '设置 win7Agent.autoLearn（正在生效：' + (config.autoLearn ? '开' : '关') + '）',
        action: 'toggle'
      });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: '经验记忆 ' + list.length + '/' + lessonsLib.MAX_LESSONS + ' 条｜自动学习 ' +
          (config.autoLearn ? '开' : '关') + '｜选中一条可直接删除'
      });
      if (!pick) { return; }
      if (pick.lessonIndex !== undefined) {
        const answer = await vscode.window.showWarningMessage('删除这条经验？\n\n' + pick.label, { modal: true }, '删除');
        if (answer === '删除') {
          await runtime.removeLesson(pick.lessonIndex);
          await refresh();
          vscode.window.showInformationMessage(APP + ': 已删除一条经验。');
        }
      } else if (pick.action === 'clear') {
        const answer = await vscode.window.showWarningMessage('清空全部自动经验？手写的长期要求会保留。', { modal: true }, '清空');
        if (answer === '清空') {
          await runtime.clearLessons();
          await refresh();
          vscode.window.showInformationMessage(APP + ': 自动经验已清空。');
        }
      } else if (pick.action === 'toggle') {
        const c = vscode.workspace.getConfiguration('win7Agent');
        await c.update('autoLearn', !config.autoLearn, runtime.settingTarget(c, 'autoLearn'));
        await refresh();
        vscode.window.showInformationMessage(APP + ': 自动学习已' + (config.autoLearn ? '关闭' : '开启') + '。');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.showPrompt', function () {
      const config = runtime.getConfig();
      runtime.showOutput();
      runtime.log('--- effective system prompt ---');
      runtime.log(runtime.getEffectivePrompt());
      runtime.log('--- hard constraints (enforced in code) ---');
      rules.describeConstraints(config.constraints).forEach(function (line) { runtime.log('- ' + line); });
      runtime.log('- 工具黑名单：' + config.constraints.deniedTools.join('、'));
      runtime.log('- Shell 开关：' + config.constraints.allowShell + '｜命令确认：' + config.constraints.confirmShell +
        '｜写入确认：' + config.constraints.confirmWrite +
        '｜工具审批：' + config.constraints.requireToolApproval + '｜子任务：' + config.subtaskMode);
      runtime.log('- confirmShell 赋值来源：' + runtime.describeSettingScope('constraints.confirmShell'));
      runtime.log('- confirmWrite 赋值来源：' + runtime.describeSettingScope('constraints.confirmWrite'));
      runtime.log('- 命令白名单：' + (config.constraints.allowedShellCommands.join('、') || '(未限制)'));
      runtime.log('- 工具轮数上限：' + config.maxToolRounds + '｜历史消息上限：' + config.maxHistoryMessages +
        ' 条（约 ' + Math.floor(config.maxHistoryMessages / 2) + ' 轮）');
      runtime.log('- 命令超时：' + config.process.timeoutMs + ' ms｜无输出判卡：' + config.process.idleTimeoutMs + ' ms');
      runtime.log('--- end ---');
      vscode.window.showInformationMessage(APP + ': 生效提示词与约束已输出到 Output 面板。');
    })
  );

  /* ---- file import / export (user-driven, not agent tools) ---- */

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.importFile', async function () {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFolders: false,
        canSelectFiles: true,
        filters: { '支持的文件': fileImport.supportedExtensions().map(function (e) { return e.slice(1); }) }
      });
      if (!uris || !uris.length) { return; }
      const done = [];
      const failed = [];
      for (let i = 0; i < uris.length; i++) {
        const fp = uris[i].fsPath;
        const rel = vscode.workspace.asRelativePath(uris[i]);
        try {
          const result = fileImport.readAsText(fp);
          const content = '以下是我导入的文件《' + rel + '》（' + result.kind + '，' + result.note + '，' +
            result.chars + ' 字符' + (result.truncated ? '，已截断' : '') + '）的内容，后续对话请以此为准：\n\n' + result.text;
          provider.addContextMessage(
            content,
            '已导入 ' + path.basename(rel) + ' · ' + result.kind + ' · ' + result.chars + ' 字符' + (result.truncated ? ' · 已截断' : ''),
            { name: rel, kind: result.kind, chars: result.chars, truncated: result.truncated }
          );
          done.push(rel + '（' + result.chars + ' 字符）');
        } catch (e) {
          failed.push(rel + '：' + (e && e.message ? e.message : String(e)));
        }
      }
      if (done.length) {
        vscode.window.showInformationMessage(APP + ': 已导入 ' + done.length + ' 个文件，列在输入框上方（点 × 可移除）。');
      }
      if (failed.length) {
        vscode.window.showErrorMessage(APP + ': ' + failed.length + ' 个文件导入失败 - ' + failed.join('；'));
      }
      await vscode.commands.executeCommand('win7Agent.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.exportAnswer', async function () {
      const answer = provider.getLastAnswer();
      if (!answer) {
        vscode.window.showInformationMessage(APP + ': 还没有可保存的回答。');
        return;
      }
      // User-initiated export is intentionally NOT gated by constraints.readOnly:
      // that constraint limits the agent, not the human.
      const uri = await vscode.window.showSaveDialog({
        filters: {
          'Markdown': ['md'],
          'CSV（表格文本）': ['csv'],
          '纯文本': ['txt'],
          '所有文件': ['*']
        },
        defaultUri: vscode.Uri.file('answer.md'),
        saveLabel: '保存回答'
      });
      if (!uri) { return; }
      try {
        const ext = String(path.extname(uri.fsPath) || '').toLowerCase();
        let out = answer;
        if (ext === '.csv') {
          // Wrap the whole answer as one CSV cell so quotes/commas/newlines
          // never corrupt the structure. This is a text export, not a data
          // transform: the model's answer is kept verbatim inside the cell.
          out = fileImport.csvEscape(answer) + '\n';
        } else if (ext === '.md' || ext === '.markdown') {
          out = answer.replace(/\r\n/g, '\n') + '\n';
        }
        fs.writeFileSync(uri.fsPath, out, 'utf8');
        vscode.window.showInformationMessage(APP + ': 回答已保存为 ' + ext + ' 文件：' + uri.fsPath);
      } catch (e) {
        vscode.window.showErrorMessage(APP + ': 保存失败 - ' + (e && e.message ? e.message : String(e)));
      }
    })
  );

  /* 启动就把定时器排上：任务在 globalState 里，重载后照常生效。 */
  armSchedules();
  const pendingJobs = runtime.getSchedules().filter(function (j) { return j.enabled !== false; }).length;
  if (pendingJobs) { runtime.log('scheduled tasks armed: ' + pendingJobs); }

  runtime.log('Endpoint: ' + runtime.getConfig().baseUrl);
  runtime.log('Ready. ' + runtime.getRuleSummary().total + ' standing rules active.');
}

function deactivate() {
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
  if (provider) { provider.dispose(); }
}

module.exports = { activate, deactivate, testHooks };
