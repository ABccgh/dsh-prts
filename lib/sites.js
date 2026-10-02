/**
 * 站点上下文（**纯函数、零依赖**）。
 *
 * 本插件只服务一个站点：**PRTS**（<https://prts.wiki>，明日方舟中文 Wiki，MediaWiki 1.43）。
 *
 * 它的 URL 形态和常见 MediaWiki 不一样，实测（2026-10-02）：
 *
 * | 项 | 值 |
 * | --- | --- |
 * | 接口 | `https://prts.wiki/api.php`（`scriptpath` 为空，接口在**根路径**） |
 * | 文章 | `https://prts.wiki/w/<标题>`（`articlepath=/w/$1`） |
 *
 * 所以 `articlePath` 必须**可配置**，不能像 `wiki.biligame.com/<key>` 那样从 baseUrl 推出来
 * （`deriveArticlePath` 只是缺省时的兜底）。
 *
 * 本模块只做三件事：归一配置里的 URL 字段、给站点上下文、拼 `apiUrl` / `pageUrl`。
 *
 * @module dsh-prts/sites
 */

/** 原始文本元素：内容不是 HTML，不能按标签配对处理（见 `html-text.js` 的说明）。 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/** 出厂站点。 */
export const DEFAULT_SITE = {
  key: 'prts',
  label: 'PRTS（明日方舟）',
  baseUrl: 'https://prts.wiki',
  apiPath: '/api.php',
  articlePath: '/w/$1',
};

/**
 * 去掉 URL 末尾的斜杠。
 * @param {unknown} value - 原始值。
 * @returns {string} 归一后的 URL（非法时为空串）。
 */
export function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/i.test(text) ? text : '';
}

/**
 * 归一 `apiPath`：保证以 `/` 开头。
 * @param {unknown} value - 原始值。
 * @returns {string} 归一后的路径。
 */
export function normalizeApiPath(value) {
  const text = String(value ?? '').trim();
  if (text === '') return DEFAULT_SITE.apiPath;
  return text.startsWith('/') ? text : `/${text}`;
}

/**
 * 由 `baseUrl` 推出缺省 `articlePath`（PRTS 的 `/w/$1` 与它不同，所以只当兜底）。
 * @param {string} baseUrl - 归一后的站点根 URL。
 * @returns {string} 文章路径模板。
 */
export function deriveArticlePath(baseUrl) {
  let pathname = '';
  try {
    pathname = new URL(baseUrl).pathname.replace(/\/+$/, '');
  } catch {
    pathname = '';
  }
  return `${pathname}/$1`;
}

/**
 * 归一 `articlePath`：保证以 `/` 开头且含 `$1`；不合规则回退到由 baseUrl 推导。
 * @param {unknown} value - 原始值。
 * @param {string} baseUrl - 归一后的站点根 URL。
 * @returns {string} 文章路径模板。
 */
export function normalizeArticlePath(value, baseUrl) {
  const text = String(value ?? '').trim();
  if (text === '' || !text.includes('$1')) return deriveArticlePath(baseUrl);
  return text.startsWith('/') ? text : `/${text}`;
}

/**
 * 造站点上下文。
 * @param {{ wikiBaseUrl?: unknown, apiPath?: unknown, articlePath?: unknown, label?: unknown, key?: unknown }} [config] 配置。
 * @returns {{ key: string, label: string, baseUrl: string, origin: string, apiPath: string, articlePath: string }} 站点上下文。
 */
export function createSite(config = {}) {
  const baseUrl = normalizeBaseUrl(config.wikiBaseUrl) || DEFAULT_SITE.baseUrl;
  const rawArticlePath = String(config.articlePath ?? '').trim();
  return {
    key: typeof config.key === 'string' && config.key.trim() !== '' ? config.key.trim() : DEFAULT_SITE.key,
    label: typeof config.label === 'string' && config.label.trim() !== '' ? config.label.trim() : DEFAULT_SITE.label,
    baseUrl,
    origin: new URL(baseUrl).origin,
    apiPath: normalizeApiPath(config.apiPath),
    // 没配就用本站出厂值（`/w/$1`）；配了但缺 `$1` 这种写法才退回「由 baseUrl 推导」。
    articlePath: rawArticlePath === '' ? DEFAULT_SITE.articlePath : normalizeArticlePath(rawArticlePath, baseUrl),
  };
}

/**
 * 拼一个 API URL。值为 `undefined` / `null` 的参数会被丢掉。
 * @param {{ baseUrl: string, apiPath: string }} site - 站点上下文。
 * @param {Record<string, string|number|boolean|undefined|null>} params - 查询参数。
 * @returns {string} 完整 URL。
 */
export function apiUrl(site, params = {}) {
  const query = new URLSearchParams({ format: 'json', formatversion: '2' });
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  return `${site.baseUrl}${site.apiPath}?${query.toString()}`;
}

/**
 * 文章页 URL。
 *
 * **按路径段编码**，并保留 `:` 字面量：PRTS 的标题里有子页与括号
 * （`阿米娅(医疗)/语音记录`），整串 `encodeURIComponent` 会把 `/` 写成 `%2F`。
 * @param {{ origin: string, articlePath: string }} site - 站点上下文。
 * @param {string} title - 页面标题。
 * @returns {string} 文章 URL。
 */
export function pageUrl(site, title) {
  const encoded = String(title ?? '')
    .trim()
    .replace(/ /g, '_')
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/');
  return `${site.origin}${site.articlePath.replace('$1', encoded)}`;
}

export { RAW_TEXT_TAGS };
