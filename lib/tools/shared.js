/**
 * 工具层共用件：统一输出形状、上限裁剪、URL 级只读缓存、时间格式化，以及
 * 「HTTP 结果 → 抛错或取值」的归一。
 *
 * 与 dsh-ck3-wiki 的同名模块相比多了四处：
 * - 缓存淘汰改成 **LRU**（命中会刷新位置）——PRTS 单页渲染 443 KB 起，
 *   命中率比「先进先出」重要得多；
 * - 新增 {@link apiErrorText}：把 MediaWiki 的 `{error:{code,info}}` 如实报出来。
 *   旧插件只在 `action=parse` 上检查它，导致「参数写错」被伪装成「没有命中」；
 * - 新增 {@link resolveNamespace}：命名空间名字/别名先经 siteinfo 解析成数字 id。
 *   直接把 `namespace=模板` 传给接口时，MediaWiki 只在 `warnings` 里说一句
 *   「Unrecognized value」然后**静默按全部命名空间搜**——这比报错更危险；
 * - 新增 {@link apiWarningText}：把 `warnings` 渲染成模型看得见的警告行。
 *
 * @module dsh-prts/tools/shared
 */

import { namespaceLabel, normalizeNamespaceName } from '../mediawiki.js';

/**
 * 每个工具的兜底超时（DSH 的 `timeoutMs`）。
 *
 * 单次 HTTP 请求默认 20 s、最多重试 3 次，再加 DSH web 兜底；90 s 是「一次工具调用
 * 最多能等多久」的上界，避免一个卡死的请求把整轮对话拖住。
 */
export const TOOL_TIMEOUT_MS = 90_000;

/**
 * 列表类端点的续取参数白名单（工具名 → 可回传的参数）。
 *
 * MediaWiki 的规矩：把上一页 `continue` 对象里的键值**原样**带回来。每个列表有
 * 自己的 `<前缀>continue`，另外还有一个通用的 `continue`。这里只放行认识的键，
 * 免得模型把任意参数塞进 URL。
 */
export const CONTINUE_KEYS = {
  search: ['sroffset', 'continue'],
  prefixsearch: ['psoffset', 'continue'],
  allpages: ['apcontinue', 'continue'],
  links: ['plcontinue', 'continue'],
  backlinks: ['blcontinue', 'continue'],
  embeddedin: ['eicontinue', 'continue'],
  categorymembers: ['cmcontinue', 'continue'],
  recentchanges: ['rccontinue', 'continue'],
};

/**
 * 把工具名（或参数白名单数组）归成数组。
 * @param {string|string[]} toolKey - 工具键或白名单。
 * @returns {string[]} 白名单。
 */
function continueKeysOf(toolKey) {
  return Array.isArray(toolKey) ? toolKey : CONTINUE_KEYS[toolKey] ?? [];
}

/**
 * 解析模型回传的 `continue` 参数。
 *
 * 输出侧用 JSON（`{"cmcontinue":"page|417263686572|18685"}`）打出完整的续取 token；
 * 输入侧两种都认：
 * - JSON 对象：按白名单挑出键值（`prts_links` 的 `in` 方向有两个列表，必须用它）；
 * - 裸 token：当成该工具主键的值（兼容手写）。
 * @param {unknown} raw - 模型传来的值。
 * @param {string|string[]} toolKey - 工具键或白名单。
 * @returns {Record<string, string>|undefined} 续取参数；没有时 undefined。
 * @throws {Error} 格式不对，或 JSON 里没有任何本工具认识的键。
 */
export function parseContinueToken(raw, toolKey) {
  const allowed = continueKeysOf(toolKey);
  const text = String(raw ?? '').trim();
  if (text === '') return undefined;
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'continue 参数格式不对：应原样回传上次输出里的 continue 值（形如 {"cmcontinue":"…"}），'
        + '或直接传上一页给出的裸 token。',
      );
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!allowed.includes(key) || value === undefined || value === null || value === '') continue;
      out[key] = String(value);
    }
    if (Object.keys(out).length === 0) {
      throw new Error(`continue 参数里没有任何可用的续取字段；本工具接受：${allowed.join('、')}。`);
    }
    return out;
  }
  const primary = allowed.find((key) => key !== 'continue');
  if (primary === undefined) {
    throw new Error(`这个工具不接受 continue 参数；可用字段：${allowed.join('、')}。`);
  }
  return { [primary]: text };
}

/**
 * 从响应里取出下一次的续取 token，序列化成 JSON 供模型原样回传。
 * @param {any|any[]} data - 解析后的 JSON（可传多个响应，用于合并两个列表）。
 * @param {string|string[]} toolKey - 工具键或白名单。
 * @returns {string} token；没有更多时为空串。
 */
export function continueTokenText(data, toolKey) {
  const allowed = continueKeysOf(toolKey);
  const sources = Array.isArray(data) ? data : [data];
  /** @type {Record<string, string>} */
  const out = {};
  for (const source of sources) {
    const token = source?.continue;
    if (token === null || typeof token !== 'object') continue;
    for (const key of allowed) {
      if (token[key] === undefined || out[key] !== undefined) continue;
      out[key] = String(token[key]);
    }
  }
  return Object.keys(out).length === 0 ? '' : JSON.stringify(out);
}


/**
 * 给标题补命名空间前缀——**只在它连冒号都没有时**。
 *
 * MediaWiki 返回的标题已经带本地化前缀（`分类:角色`、`模板:角色图鉴`、
 * `崩坏：星穹铁道:xxx`），盲补会得到 `Category:分类:角色` 这种废标题
 * （dsh-ck3-wiki 的 `withNamespace` 就踩了这个坑）。
 * @param {string} title - 标题。
 * @param {number} ns - 命名空间 id。
 * @param {Record<string, string>|undefined} labels - 运行期标签表。
 * @returns {string} 展示用标题。
 */
export function titleWithNs(title, ns, labels) {
  const label = namespaceLabel(ns, labels);
  if (label === '' || title.includes(':')) return title;
  return `${label}:${title}`;
}

/**
 * 所有 `prts_*` 工具的输出形状：一段给模型读的紧凑文本。
 *
 * 这里刻意不返回结构化对象：DSH 的输出值 schema 是简写 spec，嵌套结构一旦写错
 * 会在工具调用时变成校验失败，而模型真正需要的是可读文本。
 */
export const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true, description: '给模型阅读的文本结果' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value.text) }],
};

/** 只读工具都可以并发执行。 */
export function alwaysSafe() {
  return true;
}

/**
 * 把可选的 `limit` 参数收进合法范围。
 * @param {unknown} value - 模型传来的值。
 * @param {number} fallback - 默认值。
 * @param {number} max - 上限。
 * @returns {number} 夹紧后的整数。
 */
export function clampLimit(value, fallback, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  const fallbackClamped = Math.min(fallback, max);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackClamped;
  return Math.min(Math.trunc(parsed), max);
}

/**
 * 把可选的整数参数收进合法范围（用于 `offset` / `section` / `days`）。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @returns {number} 整数。
 */
export function clampInt(value, fallback) {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 把命名空间参数解析成接口认的数字 id（或 `*`）。
 *
 * 为什么必须解析：MediaWiki 的 `srnamespace` / `plnamespace` / `rcnamespace` 只认数字。
 * 传 `模板` 这种名字时它**不报错**，只在 `warnings` 里说一句 Unrecognized value，
 * 然后按**全部**命名空间返回——模型会以为自己只搜了模板（真站实测：`srnamespace=模板`
 * 返回 828 条、`srnamespace=10` 返回 85 条）。
 *
 * 支持：数字 id（含数字字符串）、站点本地名字 / canonical 名 / 别名（不区分大小写，
 * 末尾冒号可有可无）、`*` 或 `all`（全部）。
 * @param {object|undefined} meta - `siteMeta.get()` 的结果（含 `namespaceIds` / `namespaceList` / `labels`）。
 * @param {unknown} value - 模型传来的值。
 * @param {number|string} [fallback] - 缺省值（默认 0 主条目；列表类工具传 `'*'`）。
 * @returns {{ ns: number|'*', label: string }} 解析结果（`label` 用于回显）。
 * @throws {Error} 名字/id 不认识时抛出可执行错误。
 */
export function resolveNamespace(meta, value, fallback = 0) {
  const toResult = (ns) => {
    if (ns === '*') return { ns: '*', label: '全部' };
    const label = namespaceLabel(ns, meta?.labels);
    return { ns, label: label === '' ? '主条目' : label };
  };

  const text = typeof value === 'number' ? String(Math.trunc(value)) : String(value ?? '').trim();
  if (text === '') return toResult(typeof fallback === 'number' ? fallback : fallback === '*' ? '*' : 0);
  if (text === '*' || /^all$/i.test(text)) return toResult('*');

  /** siteinfo 拿不到时的兜底：数字 id 与 `*` 仍可用，名字给可执行提示。 */
  const namespaceList = Array.isArray(meta?.namespaceList) ? meta.namespaceList : [];
  const namespaceIds = meta?.namespaceIds !== null && typeof meta?.namespaceIds === 'object' ? meta.namespaceIds : {};

  if (/^-?\d+$/.test(text)) {
    const id = Number.parseInt(text, 10);
    if (namespaceList.length > 0 && !namespaceList.some((entry) => entry.id === id)) {
      const known = namespaceList.map((entry) => `${entry.id}（${entry.name}）`).join('、');
      throw new Error(`命名空间 id ${id} 不存在。本站在用的 id：${known}；也可以直接写名字（如 模板、分类）。`);
    }
    return toResult(id);
  }

  const id = namespaceIds[normalizeNamespaceName(text)];
  if (typeof id === 'number' && Number.isFinite(id)) return toResult(id);

  if (namespaceList.length === 0) {
    throw new Error(
      `无法解析命名空间名字「${text}」：站点信息（siteinfo）没有取到。`
      + '改传数字 id（例如 0 主条目、10 模板、14 分类）或 *（全部），或稍后重试。',
    );
  }
  const examples = namespaceList
    .filter((entry) => entry.id >= 0)
    .slice(0, 12)
    .map((entry) => `${entry.name}（${entry.id}）`)
    .join('、');
  throw new Error(
    `不认识的命名空间「${text}」。可写数字 id，或站点里的名字/别名；`
    + `常用：${examples}。传 * 表示全部命名空间。`,
  );
}

/**
 * 取一个必填的非空文本参数。
 * @param {unknown} value - 原始值。
 * @param {string} name - 参数名（写进错误消息）。
 * @returns {string} 去空白后的文本。
 * @throws {Error} 为空时。
 */
export function requireText(value, name) {
  const text = String(value ?? '').trim();
  if (text === '') throw new Error(`${name} 不能为空。`);
  return text;
}

/**
 * MediaWiki 接口错误码 → 可执行建议。
 * @param {string} code - 错误码。
 * @returns {string} 建议文本（可能为空）。
 */
export function hintForApiError(code) {
  switch (code) {
    case 'badvalue':
      return '参数值超出该站允许范围：常见原因是 limit 超过匿名上限（本插件默认 50），或 namespace 写了一个不存在的名字。';
    case 'nosuchsection':
      return 'section 不存在：渲染文本的索引来自 prts_sections 的本地目录（0 是引言）；'
        + 'wikitext 用接口自己的分节编号，两者可能不同——先不传 section 取整页，或换一个小一点的编号。';
    case 'invalidtitle':
      return '标题不合法（空标题、或含不能用于标题的字符）。';
    case 'missingtitle':
      return '页面不存在：换一个标题，或先用 prts_titles 把名字对准。';
    case 'unknown_title':
      return '页面不存在：换一个标题，或先用 prts_titles 把名字对准。';
    case 'readapidenied':
      return '该站的读取接口被拒绝了：确认 apiPath 配置与站点 key 是否正确。';
    case 'paraminfo':
      return '接口不认识某个参数：多半是 sites 配置里的 apiPath 或站点 key 写错了。';
    default:
      return '';
  }
}

/**
 * 取出 MediaWiki 的接口错误对象。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ code: string, info: string, hint: string }|undefined} 错误；没有则 undefined。
 */
export function apiError(data) {
  const error = data?.error;
  if (error === null || error === undefined) return undefined;
  const code = String(error.code ?? '');
  return { code, info: String(error.info ?? ''), hint: hintForApiError(code) };
}

/**
 * 把接口错误渲染成给模型看的文本；没有错误时返回空串。
 * @param {any} data - 解析后的 JSON。
 * @param {string} what - 这次请求在做什么。
 * @returns {string} 错误文本或空串。
 */
export function apiErrorText(data, what) {
  const error = apiError(data);
  if (error === undefined) return '';
  return [
    `${what}被 wiki 拒绝（${error.code === '' ? '未知错误' : error.code}）${error.info === '' ? '' : `：${error.info}`}`,
    error.hint === '' ? '' : `建议：${error.hint}`,
  ].filter((line) => line !== '').join('\n');
}

/**
 * 递归收集 MediaWiki 响应里的 `warnings` 文本。
 *
 * 形状不只一种：`formatversion=2` 下常见 `{ "<模块>": { "warnings": "…" } }`，
 * 也有 `{ warnings: [...] }` 与 `{ "*": "…" }` 的写法。这里只认「任何位置出现的字符串」，
 * 够用且不会因为版本差异漏掉警告。
 * @param {unknown} value - `warnings` 子树或整份响应。
 * @param {string[]} out - 收集结果。
 * @returns {void}
 */
function collectWarningStrings(value, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text !== '') out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectWarningStrings(item, out);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectWarningStrings(item, out);
  }
}

/**
 * 把接口警告渲染成给模型看的文本；没有警告时返回空串。
 *
 * 为什么要单独处理：MediaWiki 对「不认识的命名空间名字」「被夹紧的 limit」这类问题
 * **不报错只警告**，结果照样返回。不把警告显示出来，模型就会把「其实没生效的参数」
 * 当成生效了。
 * @param {any} data - 解析后的 JSON。
 * @param {string} what - 这次请求在做什么（写进警告行）。
 * @returns {string} 警告文本或空串。
 */
export function apiWarningText(data, what) {
  /** @type {string[]} */
  const collected = [];
  collectWarningStrings(data?.warnings, collected);
  const unique = [...new Set(collected)];
  if (unique.length === 0) return '';
  return unique.map((line) => `⚠ ${what}：接口警告「${line}」`).join('\n');
}

/**
 * 造一个按 URL 缓存的只读读取器：TTL 内命中直接返回，同一 URL 的并发请求合并成一次。
 *
 * 为什么需要：PRTS 的单页渲染 443 KB 起（实测 443,192 字符），而一次对话里模型常常
 * 反复读同一页（先看目录、再读某节、再回看）。缓存既省时间也更礼貌——该站有突发节流。
 *
 * 淘汰是 LRU：命中会把条目移到队尾，所以热页面不会被冷页面挤掉。
 * `fresh: true` 绕过 TTL 检查（但不会取消已合并的并发请求），成功后会重新写入缓存。
 * @param {{ json: Function }} http - 出网层取数器。
 * @param {{ ttlMs?: number, maxEntries?: number, onHit?: Function }} [options] 选项。
 * @returns {{ read: (url: string, options?: { signal?: AbortSignal, fresh?: boolean }) => Promise<object>,
 *   stats: () => { hits: number, misses: number, size: number } }} 读取器。
 */
export function createJsonReader(http, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, Math.trunc(options.ttlMs)) : 300_000;
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Math.trunc(options.maxEntries)) : 24;
  /** @type {Map<string, { at: number, value: object }>} */
  const entries = new Map();
  /** @type {Map<string, Promise<object>>} */
  const inflight = new Map();
  let hits = 0;
  let misses = 0;

  const prune = () => {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  return {
    async read(url, readOptions = {}) {
      const now = Date.now();
      if (readOptions.fresh !== true && ttlMs > 0) {
        const hit = entries.get(url);
        if (hit !== undefined && now - hit.at < ttlMs) {
          hits += 1;
          // LRU：命中即刷新位置。
          entries.delete(url);
          entries.set(url, hit);
          options.onHit?.(url);
          return hit.value;
        }
      }
      const pending = inflight.get(url);
      if (pending !== undefined) return pending;
      misses += 1;
      const task = Promise.resolve(http.json(url, { signal: readOptions.signal }))
        .then((result) => {
          if (result?.ok === true) {
            entries.delete(url);
            entries.set(url, { at: Date.now(), value: result });
            prune();
          }
          return result;
        })
        .finally(() => {
          inflight.delete(url);
        });
      inflight.set(url, task);
      return task;
    },
    stats: () => ({ hits, misses, size: entries.size }),
  };
}

/**
 * 造一个带 `AbortError` 身份的取消错误。
 *
 * DSH 只把「signal 已取消 + 抛出的值没有自己的错误身份且 name 为 AbortError」的
 * 调用记成 `ABORTED`（`dsh-tools` 的 pipeline 判定）；普通 `Error` 会被记成一次
 * 普通工具失败，界面上就看不出是用户取消了。
 * @param {string} [message] - 错误消息。
 * @returns {Error} name 为 AbortError 的错误。
 */
export function abortError(message = '请求已被取消') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * 把出网层的结果变成「值或异常」。
 * @param {{ ok: boolean, data?: unknown, error?: string, hint?: string, unexpectedBody?: boolean,
 *   url?: string, via?: string, attempts?: number, aborted?: boolean }} result - `fetchJson` 的结果。
 * @param {string} what - 这次请求在做什么（写进错误消息）。
 * @returns {unknown} 解析后的 JSON。
 * @throws {Error} 失败时抛出带建议的错误；取消时抛 AbortError。
 */
export function unwrap(result, what) {
  if (result?.aborted === true) throw abortError();
  if (result?.ok === true) return result.data;
  const lines = [`${what}失败：${result?.error ?? '未知错误'}`];
  if (typeof result?.hint === 'string' && result.hint !== '') lines.push(`建议：${result.hint}`);
  if (typeof result?.url === 'string') lines.push(`请求：${result.url}`);
  throw new Error(lines.join('\n'));
}

/**
 * 把 ISO 时间变成「刚刚 / 12 分钟前 / 3 小时前 / 2 天前 / 日期」。
 * @param {string|undefined} iso - ISO 8601 时间戳。
 * @param {Date} [now] - 当前时间（便于测试）。
 * @returns {string} 可读时间；无法解析时返回空串。
 */
export function formatAge(iso, now) {
  if (typeof iso !== 'string' || iso === '') return '';
  const when = Date.parse(iso);
  if (!Number.isFinite(when)) return '';
  const deltaMs = (now instanceof Date ? now.getTime() : Date.now()) - when;
  const minutes = Math.round(deltaMs / 60_000);
  if (Math.abs(minutes) < 1) return '刚刚';
  if (Math.abs(minutes) < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 31) return `${days} 天前`;
  return iso.slice(0, 10);
}

/**
 * 列表输出的尾注（所有列表类工具共用一句话，避免「共 N 条 + 还有更多」自相矛盾）。
 *
 * 列表端点通常只告诉你「这一页有几条」，不告诉你总量（backlinks/embeddedin/
 * categorymembers/recentchanges 都没有总数），所以：
 * - 知道总数：`共 85 个页面，本次显示 30 个`
 * - 不知道：`本次显示 30 个页面`
 * 再用一句话说明「还有更多怎么取」或「已到末尾」。
 * @param {number} shown - 本次显示条数。
 * @param {number|null} total - 总数（未知时传 null）。
 * @param {string} unit - 计数单位，例如「个页面」。
 * @param {string} [nextHint] - 继续取下一页的提示（空串表示没有更多）。
 * @returns {string} 尾注文本。
 */
export function listTail(shown, total, unit, nextHint = '') {
  const head = total === null || total === undefined
    ? `本次显示 ${shown} ${unit}`
    : `共 ${total} ${unit}，本次显示 ${shown} 条`;
  const hint = nextHint === '' ? '，已到末尾' : `；${nextHint}`;
  return `\n（${head}${hint}）`;
}

/**
 * 输出头：标题 + 来源 + 时间等信息，便于模型引用。
 * @param {Array<string|undefined|null>} lines - 头信息行。
 * @returns {string} 头部文本（每条一行，末尾空行分隔）。
 */
export function header(lines) {
  const kept = lines.filter((line) => typeof line === 'string' && line !== '');
  return kept.length === 0 ? '' : `${kept.join('\n')}\n\n`;
}
