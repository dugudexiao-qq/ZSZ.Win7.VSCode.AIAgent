'use strict';

/*
 * 完成度自检（task check）
 *
 * 背景：本地小模型很容易"自述完成"，回一句"已完成"，可这一轮一次工具都没调用，
 * 文件也没改。用户看不出真假，只能自己回头核对。这里不看模型怎么说，只看这一轮
 * 真实的动作痕迹（工具调用次数、成功/失败/被拦、写入是否真的落在磁盘上），给出
 * 一条能核对的结论，画在回答下面。
 *
 * 这是启发式判断，不是铁证：
 *   - 零工具调用时，结论很硬（确实什么都没做）；
 *   - 有动作但结局可疑时只提醒，不阻断；
 *   - 纯问答不打卡片，避免刷屏。
 *
 * 纯函数、零依赖、不 require('vscode')，可单独单测。
 */

/* 模型自称完成的说法。命中且同一句里没有否定/失败词，才认为它在"声称完成"。 */
var CLAIM_WORDS = [
  '已完成', '已经完成', '完成了', '做好了', '搞定了', '搞定',
  '已创建', '已新建', '已写入', '已保存', '已生成', '已导出',
  '已修改', '已更新', '已删除', '已移动', '已复制', '已安装', '已部署', '已执行', '已运行'
];

/* 需要"动手"的动词。命中即认为这条消息要求实际的工具动作。 */
var ACTION_WORDS = [
  '复制', '创建', '新建', '写入', '保存', '生成', '导出', '修改', '改写', '替换',
  '删除', '移动', '重命名', '整理', '清理', '归档', '安装', '部署', '运行', '执行',
  '编译', '打包', '启动', '测试', '批量', '合并', '拆分', '转换', '下载', '上传',
  '导入', '统计', '扫描', '备份', '恢复', '列出', '读取', '检查',
  '写', '改', '建', '读', '跑'
];

/* 其中会产生/改动文件的那部分。 */
var WRITE_WORDS = [
  '复制', '创建', '新建', '写入', '保存', '生成', '导出', '修改', '改写', '替换',
  '删除', '移动', '重命名', '整理', '清理', '归档', '合并', '拆分', '转换', '备份', '恢复',
  '写', '改', '建'
];

/* 疑问句标记：只是问"怎么做"而不是让你去做。 */
var QUESTION_WORDS = [
  '怎么', '如何', '为什么', '是什么', '什么是', '是否', '能不能', '可不可以',
  '会不会', '有没有', '行不行', '该不该', '要不要'
];

/* 明确的祈使说法：出现时即使带疑问词，也按"要动手"处理（例如"能帮我写进 a.js 吗"）。 */
var IMPERATIVE_WORDS = ['帮我', '帮忙', '请你', '请帮', '给我', '麻烦', '直接', '现在就', '先']; 

/* 否定/失败的说法：出现时不算"声称完成"。 */
var FAIL_WORDS = [
  '失败', '无法', '不能', '未能', '没有权限', '被拒绝', '未执行', '没有做', '做不到', '出错'
];

function hit(text, words) {
  var src = String(text || '');
  var found = [];
  for (var i = 0; i < words.length; i++) {
    if (src.indexOf(words[i]) !== -1) { found.push(words[i]); }
  }
  return found;
}

/* 只看最后一条用户消息：导入文件会把整篇文件内容压成一条 user 消息，
 * 拿全部历史做匹配会把"纯问答"误判成"要动手"。
 *
 * "怎么写这个函数"这类问句不该被当成任务：命中疑问词、又没有任何祈使说法时
 * 判为纯问答。反过来"能帮我写进 a.js 吗"有祈使说法，仍按任务处理。 */
function detectIntent(userText) {
  var text = String(userText || '');
  var action = hit(text, ACTION_WORDS);
  var write = hit(text, WRITE_WORDS);
  var question = hit(text, QUESTION_WORDS);
  var imperative = hit(text, IMPERATIVE_WORDS);
  var wantsAction = action.length > 0;
  if (wantsAction && question.length && !imperative.length) { wantsAction = false; }
  return {
    wantsAction: wantsAction,
    wantsWrite: wantsAction && write.length > 0,
    actionWords: action,
    writeWords: write,
    question: question.length > 0 || /[?？]\s*$/.test(text)
  };
}

function claimsCompletion(answer) {
  var text = String(answer || '');
  if (hit(text, FAIL_WORDS).length) { return ''; }
  var claims = hit(text, CLAIM_WORDS);
  return claims.length ? claims[0] : '';
}

function normalizeTools(tools) {
  var list = Array.isArray(tools) ? tools : [];
  return list.filter(function (t) { return t && t.tool; }).map(function (t) {
    return {
      tool: String(t.tool),
      status: t.status === 'ok' || t.status === 'blocked' ? t.status : (t.status === 'failed' ? 'failed' : 'ok'),
      path: t.path ? String(t.path) : '',
      error: t.error ? String(t.error).slice(0, 160) : ''
    };
  });
}

function toolLine(tools) {
  var map = {};
  var order = [];
  tools.forEach(function (t) {
    if (!map[t.tool]) { map[t.tool] = { ok: 0, failed: 0, blocked: 0 }; order.push(t.tool); }
    map[t.tool][t.status] += 1;
  });
  return order.map(function (name) {
    var m = map[name];
    var parts = [];
    if (m.ok) { parts.push('成功 ' + m.ok); }
    if (m.failed) { parts.push('失败 ' + m.failed); }
    if (m.blocked) { parts.push('被拦 ' + m.blocked); }
    return name + '(' + parts.join('/') + ')';
  }).join('，');
}

function evidenceOf(tools, checks, stats) {
  var out = [];
  out.push('工具调用 ' + tools.length + ' 次' + (tools.length ? '：' + toolLine(tools) : ''));
  if (stats && stats.roundCount) { out.push('模型往返 ' + stats.roundCount + ' 轮'); }
  if (checks.length) {
    out.push('写入文件 ' + checks.length + ' 个：' + checks.map(function (c) {
      var state = c.exists
        ? '存在，' + (c.size || 0) + ' 字节' + (c.fresh ? '，本轮已更新' : '，修改时间不在本轮')
        : '磁盘上不存在';
      return c.path + '（' + state + '）';
    }).join('；'));
  } else {
    out.push('写入文件 0 个');
  }
  return out;
}

function mk(verdict, level, title, text, evidence, extra) {
  var out = {
    verdict: verdict,
    level: level,
    title: title,
    text: text,
    evidence: evidence || []
  };
  if (extra) {
    out.intent = extra.intent;
    out.stats = extra.stats;
  }
  return out;
}

/*
 * input = {
 *   userText : 本轮用户最后一条消息
 *   answer   : 模型最终回答
 *   trace    : {
 *     rounds, tools:[{tool,status,path,error}], writeChecks:[{path,exists,size,fresh}],
 *     error, cancelled, exhausted, streamMode
 *   }
 * }
 * level: 'ok' | 'warn' | 'fail' | 'none'（none = 不打卡片）
 */
function evaluate(input) {
  var src = input || {};
  var trace = src.trace || {};
  var tools = normalizeTools(trace.tools);
  var checks = Array.isArray(trace.writeChecks) ? trace.writeChecks : [];
  var intent = detectIntent(src.userText);
  var answer = String(src.answer || '');

  var stats = {
    roundCount: Number(trace.rounds) || 0,
    toolCount: tools.length,
    okCount: 0,
    failCount: 0,
    blockedCount: 0,
    writeCount: checks.length,
    verifiedCount: 0
  };
  tools.forEach(function (t) {
    if (t.status === 'ok') { stats.okCount += 1; }
    else if (t.status === 'blocked') { stats.blockedCount += 1; }
    else { stats.failCount += 1; }
  });
  checks.forEach(function (c) { if (c && c.exists) { stats.verifiedCount += 1; } });

  var context = { intent: intent, stats: stats };
  var evidence = evidenceOf(tools, checks, stats);
  var errText = String(trace.error || '');

  /* 1. 出错 / 被取消：都不算完成。 */
  if (errText) {
    if (/cancel|abort|取消|中断/i.test(errText)) {
      return mk('cancelled', 'fail', '本轮被中断，没有正常收尾',
        '你点了 Stop 或请求被取消。' + (stats.okCount
          ? '中断前已有 ' + stats.okCount + ' 个动作完成，可以对照下面的记录确认哪些已经生效。'
          : '中断前没有任何动作完成。'),
        evidence, context);
    }
    return mk('error', 'fail', '本轮出错，不能算完成',
      '出错信息：' + errText.slice(0, 300), evidence, context);
  }

  /* 2. 没有动作意图：纯问答，不打卡片。 */
  if (!intent.wantsAction) {
    return mk('talk-only', 'none', '纯问答，无需动作',
      '这条消息更像提问或讨论，自检不做判断。', [], context);
  }

  /* 3. 一次工具都没调：这是最常见、也最硬的"假完成"。 */
  if (!tools.length) {
    var claimed = claimsCompletion(answer);
    if (claimed) {
      return mk('false-claim', 'fail', '声称已完成，但一步都没做',
        '模型在回复里写了「' + claimed + '」，可这一轮没有调用任何工具：没读文件、没写文件、没执行命令。' +
        '建议直接回一句「先调用工具再回答」，或检查写入模式是否只读。',
        evidence, context);
    }
    return mk('no-action', 'fail', '只给了文字，没有任何实际操作',
      '这条消息要求动手，但模型只回复了文字，没有调用任何工具。可以要求它「先调用工具再回答」。',
      evidence, context);
  }

  /* 4. 调了工具，但一个都没成功。 */
  if (!stats.okCount) {
    var blocked = stats.blockedCount > 0;
    return mk(blocked ? 'blocked' : 'failed', 'fail',
      blocked ? '动作被约束拦下了，任务没推进' : '动作全部失败，任务没推进',
      blocked
        ? '这一轮的工具调用全部被规则拦住或被你拒绝。若是自己关的开关（写入模式 / 命令确认 / 工具审批），确认后重新提一次。'
        : '这一轮的工具调用全部报错，可以看上方红色记录或输出面板里的详细错误。',
      evidence, context);
  }

  /* 5. 被轮数上限打断：不一定是真做完。放在前面，因为"被截断"比"某类动作没看到"
   * 更能解释这一轮的结局。 */
  if (trace.exhausted) {
    return mk('max-rounds', 'warn', '达到工具轮数上限，可能没做完',
      '这一轮用满了 ' + stats.roundCount + ' 轮工具往返，是被轮数上限打断的，不一定是真的完成。' +
      '可以调大 win7Agent.maxToolRounds，或让它接着做。',
      evidence, context);
  }

  /* 6. 要求产生文件，却没有任何写入、也没有成功的命令。 */
  var editorWritten = tools.some(function (t) { return t.tool === 'insertText' && t.status === 'ok'; });
  var cmdOk = tools.some(function (t) { return t.tool === 'runCommand' && t.status === 'ok'; });
  if (intent.wantsWrite && !checks.length && !editorWritten && !cmdOk) {
    return mk('incomplete', 'warn', '有动作，但没看到落盘的写入',
      '这条消息要求产生或改动文件，可这一轮没有成功的 createFile / saveText / insertText，也没有成功的命令执行。' +
      '如果只是回答了做法，那就不算做完。',
      evidence, context);
  }

  /* 7. 写了，但磁盘上找不到（或被写到别处）。 */
  if (checks.length && stats.verifiedCount < checks.length) {
    var missing = checks.filter(function (c) { return !c.exists; }).map(function (c) { return c.path; });
    return mk('unverified', 'warn', '写了，但磁盘上没找到',
      '有 ' + (checks.length - stats.verifiedCount) + ' 个文件在写入后无法确认存在：' + missing.join('、'),
      evidence, context);
  }

  /* 8. 只读任务全部成功：不打卡片。读文件、列目录这类每轮都成功的动作，
   * 打卡片只会把聊天区塞满；真要出问题会走上面的失败/拦截分支。 */
  if (!intent.wantsWrite && !cmdOk && !checks.length) {
    return mk('done', 'none', '只读动作已完成，无需自检卡片', '', evidence, context);
  }

  /* 9. 有成功动作、写入也核对到了。 */
  return mk('done', 'ok', '有实际动作，已完成',
    '工具调用 ' + stats.toolCount + ' 次（成功 ' + stats.okCount + ' 次）' +
    (checks.length ? '，写入 ' + checks.length + ' 个文件且都已在磁盘上确认' : '') + '。',
    evidence, context);
}

module.exports = {
  evaluate: evaluate,
  detectIntent: detectIntent,
  claimsCompletion: claimsCompletion,
  normalizeTools: normalizeTools,
  CLAIM_WORDS: CLAIM_WORDS,
  ACTION_WORDS: ACTION_WORDS,
  WRITE_WORDS: WRITE_WORDS,
  FAIL_WORDS: FAIL_WORDS
};
