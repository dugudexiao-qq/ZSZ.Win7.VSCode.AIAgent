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

const APP = manifest.displayName;
const EXT_ID = manifest.publisher + '.' + manifest.name;
let provider = null;

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

function activate(context) {
  runtime.initRuntime(context);
  const info = runtime.getExtensionInfo();
  runtime.log(info.name + ' v' + info.version + ' by ' + info.author);
  runtime.log('Target: ' + info.target + ' | running VS Code ' + vscode.version + ' / Node ' + process.versions.node);

  provider = new ChatViewProvider(context.extensionUri);
  function refresh() { return provider.postState(); }

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
        runtime.log('write mode -> ' + (nowOn ? 'ON' : 'OFF') +
          ' (readOnly=' + (!nowOn) + ', allowWrite=' + nowOn + ')');
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
        ignoreFocusOut: true,
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
        password: true,
        ignoreFocusOut: true
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

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.addRule', async function () {
      const text = await vscode.window.showInputBox({
        prompt: '这条要求会长期记住，并在之后每次请求前注入系统提示词（存于 VS Code globalState）。',
        placeHolder: '例如：所有代码注释用中文；回答控制在 200 字以内',
        ignoreFocusOut: true
      });
      if (text === undefined) { return; }
      const result = await runtime.addMemoryRule(text);
      await refresh();
      if (result.ok) { vscode.window.showInformationMessage(APP + ': ' + result.message); }
      else { vscode.window.showWarningMessage(APP + ': ' + result.message); }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('win7Agent.manageRules', async function () {
      const memory = runtime.getMemoryRules();
      const summary = runtime.getRuleSummary();
      const items = memory.map(function (rule, index) {
        return { label: rule, description: '点击删除这条记忆', ruleIndex: index };
      });
      items.push({ label: '$(add) 记住一条新要求', description: '追加到长期记忆', action: 'add' });
      items.push({ label: '$(trash) 清空全部记忆', description: '出厂默认规则不受影响', action: 'clear' });
      items.push({ label: '$(eye) 查看生效提示词与约束', description: '输出到 Output 面板', action: 'show' });
      items.push({ label: '$(plug) 设置服务地址 / 端口', description: '当前 ' + endpoint.shortEndpoint(runtime.getConfig().baseUrl), action: 'endpoint' });
      items.push({ label: '$(gear) 打开约束设置', description: '只读 / 工具黑名单 / Shell / 超时', action: 'settings' });
      items.push({ label: '$(file-text) 直接编辑 settings.json', description: '设置界面空白时用这个', action: 'settingsjson' });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: '长期通用要求：默认 ' + summary.defaultCount + ' 条 + 记忆 ' + summary.memoryCount + ' 条｜只读 ' +
          (summary.constraints.readOnly ? '开' : '关') + '｜Shell ' + (summary.constraints.allowShell ? '开' : '关')
      });
      if (!pick) { return; }
      if (pick.ruleIndex !== undefined) {
        await runtime.removeMemoryRule(pick.ruleIndex);
        await refresh();
        vscode.window.showInformationMessage(APP + ': 已删除一条记忆规则。');
      } else if (pick.action === 'add') {
        await vscode.commands.executeCommand('win7Agent.addRule');
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

  runtime.log('Endpoint: ' + runtime.getConfig().baseUrl);
  runtime.log('Ready. ' + runtime.getRuleSummary().total + ' standing rules active.');
}

function deactivate() {
  if (provider) { provider.dispose(); }
}

module.exports = { activate, deactivate };
