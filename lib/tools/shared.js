/**
 * 工具层共用件：统一输出形状、上限裁剪、URL 级只读缓存、时间格式化，以及
 * 「HTTP 结果 → 抛错或取值」的归一。
 *
 * 与 dsh-ck3-wiki 的同名模块相比多了两处：
 * - 缓存淘汰改成 **LRU**（命中会刷新位置）——PRTS 单页渲染 443 KB 起，
 *   命中率比「先进先出」重要得多；
 * - 新增 {@link apiErrorText}：把 MediaWiki 的 `{error:{code,info}}` 如实报出来。
 *   旧插件只在 `action=parse` 上检查它，导致「参数写错」被伪装成「没有命中」。
 *
 * @module dsh-prts/tools/shared
 */

import { namespaceLabel } from '../mediawiki.js';

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
 * 归一「命名空间」参数：接受 id、命名空间名字，或 `*` / `all`（表示全部命名空间）。
 * MediaWiki 这几种写法都认，这里只做透传与默认值。
 * @param {unknown} value - 模型传来的值。
 * @param {number|string} [fallback] - 缺省值（默认 0，即主条目）。
 * @returns {string} 传给接口的值。
 */
export function namespaceParam(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return String(fallback);
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : String(fallback);
  const text = String(value).trim();
  if (text === '') return String(fallback);
  if (text === '*' || /^all$/i.test(text)) return '*';
  return text;
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
      return 'section 不存在：先看目录再传（section=0 是引言）。';
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
 * 把出网层的结果变成「值或异常」。
 * @param {{ ok: boolean, data?: unknown, error?: string, hint?: string, unexpectedBody?: boolean,
 *   url?: string, via?: string, attempts?: number }} result - `fetchJson` 的结果。
 * @param {string} what - 这次请求在做什么（写进错误消息）。
 * @returns {unknown} 解析后的 JSON。
 * @throws {Error} 失败时抛出带建议的错误。
 */
export function unwrap(result, what) {
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
 * 「只显示了前 N 条」的尾注。
 * @param {number} shown - 已显示条数。
 * @param {number|null} total - 总数（未知时传 null）。
 * @param {string} unit - 计数单位，例如「个页面」。
 * @param {string} [nextHint] - 继续取下一页的提示。
 * @returns {string} 尾注文本（不需要时为空串）。
 */
export function listTail(shown, total, unit, nextHint = '') {
  const totalText = total === null || total === undefined ? `${shown} ${unit}` : `共 ${total} ${unit}`;
  const hint = nextHint === '' ? '' : `；${nextHint}`;
  return `\n（${totalText}，本次显示 ${shown} 条${hint}）`;
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
