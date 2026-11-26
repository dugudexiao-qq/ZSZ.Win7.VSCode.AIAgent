/* 按模型名推断上下文窗口，并给出这个模型该配多少上下文预算。
 *
 * 为什么要做这件事：maxContextChars 是个裸数字，绝大多数人不知道该填什么，
 * 就直接用默认 8000——接的是 128k 的云端模型，白白让 AI 只能记住最近几轮；
 * 反过来接了 8k 的本地小模型却填 60000，请求会被服务端截断甚至报错。
 * 模型名是唯一已知的线索，于是按名字里的族系估一个窗口，再按经验折算成
 * 历史字符预算：留 30% 给系统提示、输出和工具结果（这些不占历史预算）。
 *
 * 估错的代价是可控的：这里只给推荐，写不写进设置由用户点一下决定，
 * 而且 maxContextChars 本身还有 2000..200000 的硬边界。
 */

/* 顺序有意义：先具体后宽泛，命中即返回。窗口取该族系常见版本的保守值，
 * 宁可估小一点——估小只是少记几轮，估大会直接让请求失败。 */
const RULES = [
  /* OpenAI */
  { re: /\bgpt-4\.1\b|\bgpt-4o\b|\bgpt-4-turbo\b|\bo1\b|\bo3\b|\bo4-mini\b/, tokens: 128000 },
  { re: /\bgpt-4-32k\b|\bgpt-4\.5\b/, tokens: 32768 },
  { re: /\bgpt-4\b/, tokens: 8192 },
  { re: /\bgpt-3\.5\b/, tokens: 16384 },
  { re: /\bgpt-5\b/, tokens: 200000 },
  /* Anthropic */
  { re: /claude/, tokens: 200000 },
  /* DeepSeek：V3 / R1 系列 API 都是 128k */
  { re: /deepseek/, tokens: 128000 },
  /* 通义千问：只有云端 max/plus/turbo 是 128k，本地 7B/14B/30B 原生 32k
   * （Qwen3 也一样，再长要自己改 RoPE，不能按名字默认）。 */
  { re: /qwen[\d.]*-(max|plus|turbo|long)/, tokens: 128000 },
  { re: /qwen/, tokens: 32768 },
  /* Llama 3.x 原生 128k，3.0 与老版本小得多 */
  { re: /llama-?3\.[123]/, tokens: 128000 },
  { re: /llama-?3/, tokens: 8192 },
  { re: /llama/, tokens: 4096 },
  /* Mistral / Mixtral */
  { re: /mixtral|mistral-large|codestral/, tokens: 32768 },
  { re: /mistral/, tokens: 32768 },
  /* 智谱 GLM */
  { re: /glm-4/, tokens: 128000 },
  { re: /glm/, tokens: 8192 },
  /* Google：窗口巨大，最终会被 200000 的硬上限截住 */
  { re: /gemini/, tokens: 1000000 },
  /* Kimi / Moonshot */
  { re: /moonshot|kimi/, tokens: 128000 },
  /* 零一万物 */
  { re: /yi-large|yi-medium|yi-lightning/, tokens: 32768 },
  /* 上海 AI Lab */
  { re: /internlm/, tokens: 32768 },
  /* 百川 */
  { re: /baichuan/, tokens: 32768 },
  /* 百度文心 */
  { re: /ernie/, tokens: 8192 },
  /* Cohere */
  { re: /command-r/, tokens: 128000 },
  /* Google Gemma */
  { re: /gemma-?3/, tokens: 128000 },
  { re: /gemma/, tokens: 8192 },
  /* Microsoft Phi（mini 系列默认 4k，长上下文版名字里带 128k） */
  { re: /phi-[\d.]+.*128k/, tokens: 128000 },
  { re: /phi/, tokens: 4096 }
];

const MIN_CHARS = 2000;
const MAX_CHARS = 200000;
/* 历史预算占窗口的比例：剩下 30% 留给系统提示、工具结果和模型输出。 */
const HISTORY_SHARE = 0.7;
/* 一条消息大约多少字符——用来把字符预算折成「携带多少条历史」。 */
const CHARS_PER_MESSAGE = 80;

function normalizeModel(model) {
  let s = String(model || '').trim().toLowerCase();
  if (!s) { return ''; }
  /* 去掉 litellm / openrouter 那种 provider 前缀（openai/gpt-4o）与路径式
   * 前缀（models/xxx），只留模型本身。 */
  s = s.replace(/^[a-z0-9_.-]+\//, '');
  return s;
}

function inferWindow(model) {
  const name = normalizeModel(model);
  if (!name) { return null; }
  for (let i = 0; i < RULES.length; i++) {
    if (RULES[i].re.test(name)) {
      return { model: String(model), tokens: RULES[i].tokens };
    }
  }
  return null;
}

function clampChars(n) {
  const v = Math.round(Number(n) / 1000) * 1000;
  if (!Number.isFinite(v)) { return MIN_CHARS; }
  return Math.max(MIN_CHARS, Math.min(MAX_CHARS, v));
}

/* 推荐配置。返回 null 表示模型名没认出来——这时候不该硬塞一个数字，
 * 界面只说「没识别到模型」，让人按模型说明自己填。 */
function recommendContext(model) {
  const hit = inferWindow(model);
  if (!hit) { return null; }
  const chars = clampChars(hit.tokens * HISTORY_SHARE);
  /* 条数只是「别无限累积」的第二道闸，真正卡住的是字符预算，所以这里按
   * 每条约 80 字符折算后封顶 500 条——再多也只是个虚数，字符先撞线。 */
  const messages = Math.max(20, Math.min(500, Math.round(chars / CHARS_PER_MESSAGE / 10) * 10));
  return {
    model: hit.model,
    tokens: hit.tokens,
    chars: chars,
    messages: messages,
    note: '按 ' + Math.round(hit.tokens / 1000) + 'k 上下文窗口估算，留 30% 给系统提示、工具结果和回复'
  };
}

/* 当前设置离推荐值有多远。20% 以内算「差不多」，不做打扰。 */
function needsAdjust(current, target) {
  const want = Number(target);
  if (!Number.isFinite(want) || want <= 0) { return false; }
  const cur = Number(current);
  if (!Number.isFinite(cur) || cur <= 0) { return true; }
  return Math.abs(cur - want) / want > 0.2;
}

module.exports = {
  RULES,
  MIN_CHARS,
  MAX_CHARS,
  HISTORY_SHARE,
  inferWindow,
  recommendContext,
  needsAdjust
};
