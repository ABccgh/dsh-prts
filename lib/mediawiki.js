/**
 * MediaWiki 数据层：**纯函数**。每个端点一个 URL 构造器 + 一个响应映射器。
 *
 * 这一版按 PRTS 的实测行为做了这些取舍（同源代码见 dsh-ck3-wiki / dsh-bwiki）：
 *
 * - 全部端点都走**站点上下文**（`sites.js` 的 `site` 对象），因为插件是多站点的；
 * - 标题候选用 `list=prefixsearch`（该站 `opensearch` 也可用，但 prefixsearch 一次就能拿到标题与 pageid），
 *   并以 `list=allpages` 作为前缀枚举兜底；
 * - **不使用 `action=parse&section=N`**：该站 `prop=sections` 混着页面自身索引与模板来的 `T-1`，
 *   `index` 是 `T-1` 这类值、`byteoffset` 为 null，接口要么报 `nosuchsection` 要么返回空。
 *   分节改为「取整页渲染 → 本地目录 → 本地切片」（`html-text.js`）；
 * - wikitext 走 `action=parse&prop=wikitext`（比 `query&prop=revisions` 少一层 slots 解包，
 *   而且错误形状与 `prop=text` 一致）；
 * - 命名空间标签优先用站点 siteinfo 的**本地化**名字（`14` 是 `分类` 而不是 `Category`）；
 * - `pageUrl` 在 `sites.js` 里，按路径段编码（子页标题 `希儿/攻略` 不被写成 `%2F`）。
 *
 * 本模块不 import 任何东西（除了同层的 `sites.js`），也不做网络 IO——所有 IO 在 `http.js`。
 *
 * @module dsh-prts/mediawiki
 */

import { apiUrl, pageUrl } from './sites.js';

/** 分类命名空间的默认名字（canonical + 中文别名）。siteinfo 的别名会再并进来。 */
export const DEFAULT_CATEGORY_NAMES = ['Category', '分类'];

/**
 * 内置命名空间标签（中文），作为 siteinfo 拿不到时的兜底；真实名字以各站 siteinfo 为准。
 *
 * `4`（Project）在各站是**站名本身**（`崩坏：星穹铁道`、`原神`……），所以这里只写通用的「项目」，
 * 真实运行时以 siteinfo 的 `namespaces` 为准。
 */
export const DEFAULT_NAMESPACE_LABELS = {
  '-2': '媒体文件',
  '-1': '特殊',
  0: '',
  1: '讨论',
  2: '用户',
  3: '用户讨论',
  4: '项目',
  5: '项目讨论',
  6: '文件',
  7: '文件讨论',
  8: 'MediaWiki',
  9: 'MediaWiki 讨论',
  10: '模板',
  11: '模板讨论',
  12: '帮助',
  13: '帮助讨论',
  14: '分类',
  15: '分类讨论',
  102: '属性',
  106: '表单',
  108: '概念',
  112: 'smw/schema',
  114: 'Rule',
  274: '微件',
  828: '模块',
  829: '模块讨论',
  2300: 'Gadget',
  2302: 'Gadget definition',
  2600: 'Topic',
};

/**
 * 命名空间的显示标签。
 * @param {number|undefined} ns - 命名空间 id。
 * @param {Record<string, string>} [labels] - 运行期标签表（siteinfo 来的）。
 * @returns {string} 标签；未知 id 回退成 `ns<id>`，主条目返回空串。
 */
export function namespaceLabel(ns, labels) {
  if (ns === undefined || ns === null) return '';
  const key = String(ns);
  const table = labels !== undefined && labels !== null ? labels : DEFAULT_NAMESPACE_LABELS;
  if (Object.hasOwn(table, key)) return String(table[key] ?? '');
  if (Object.hasOwn(DEFAULT_NAMESPACE_LABELS, key)) return String(DEFAULT_NAMESPACE_LABELS[key]);
  return `ns${key}`;
}

/**
 * 转义正则里的字面量。
 * @param {string} text - 原文本。
 * @returns {string} 转义后的文本。
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 剥掉分类名上的命名空间前缀（`Category:`、`分类:`，以及 siteinfo 给的别名）。
 * @param {string} title - 标题，例如 `分类:角色`。
 * @param {string[]} [aliases] - 已知的分类命名空间名。
 * @returns {string} 不含前缀的名字。
 */
export function stripCategoryPrefix(title, aliases = DEFAULT_CATEGORY_NAMES) {
  let value = String(title ?? '').trim();
  for (const alias of aliases) {
    if (typeof alias !== 'string' || alias === '') continue;
    const pattern = new RegExp(`^${escapeRegExp(alias)}\\s*:\\s*`, 'i');
    if (pattern.test(value)) {
      value = value.replace(pattern, '').trim();
      break;
    }
  }
  return value;
}

/**
 * 把用户给的分类名补成接口认的规范标题。接受 `角色`、`分类:角色`、`Category:角色`。
 * @param {string} category - 分类名。
 * @param {string[]} [aliases] - 已知的分类命名空间名。
 * @returns {string} `Category:<名字>`。
 */
export function categoryTitle(category, aliases = DEFAULT_CATEGORY_NAMES) {
  return `Category:${stripCategoryPrefix(category, aliases)}`;
}

/** siteinfo：站点名、MW 版本、语言、首页、统计、命名空间与其别名。 */
export function siteInfoUrl(site) {
  return apiUrl(site, {
    action: 'query',
    meta: 'siteinfo',
    siprop: 'general|statistics|namespaces|namespacealiases',
  });
}

/** 全文检索（PRTS 用 MediaWiki 内置后端：没有 CirrusSearch，不存在 intitle:/incategory:/insource: 语法）。 */
export function searchUrl(site, { query, limit, offset, namespace } = {}) {
  return apiUrl(site, {
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: limit,
    sroffset: offset,
    srnamespace: namespace,
    srprop: 'snippet|timestamp|wordcount|size',
  });
}

/** 标题前缀候选（`list=prefixsearch`）。 */
export function prefixSearchUrl(site, { query, limit, namespace } = {}) {
  return apiUrl(site, {
    action: 'query',
    list: 'prefixsearch',
    pssearch: query,
    pslimit: limit,
    psnamespace: namespace,
  });
}

/** 前缀枚举兜底（`list=allpages`）。 */
export function allPagesUrl(site, { prefix, limit, namespace } = {}) {
  return apiUrl(site, {
    action: 'query',
    list: 'allpages',
    apprefix: prefix,
    aplimit: limit,
    apnamespace: namespace,
  });
}

/**
 * 页面渲染 HTML（整页）。
 *
 * 刻意**不带 `section`**：该站的 section 索引混着 `T-1` 这类模板值，分节在本地做。
 * `disabletoc/disableeditsection/disablelimitreport` 顺手去掉 MediaWiki 自己的目录、
 * 段落编辑链接与 NewPP 报告注释。
 */
export function pageTextUrl(site, { title } = {}) {
  return apiUrl(site, {
    action: 'parse',
    page: title,
    prop: 'text|revid',
    redirects: '1',
    disabletoc: '1',
    disableeditsection: '1',
    disablelimitreport: '1',
  });
}

/** 页面原始 wikitext（`action=parse&prop=wikitext`）。 */
export function wikitextUrl(site, { title } = {}) {
  return apiUrl(site, { action: 'parse', page: title, prop: 'wikitext|revid', redirects: '1' });
}

/** 页面元数据：pageid、字节数、最后编辑（revid/时间/编辑者/摘要）、分类。 */
export function pageInfoUrl(site, { title, categoryLimit } = {}) {
  return apiUrl(site, {
    action: 'query',
    titles: title,
    prop: 'info|pageprops|categories|revisions',
    inprop: 'url|displaytitle',
    cllimit: categoryLimit,
    clprop: 'timestamp|sortkey',
    rvprop: 'ids|timestamp|user|comment',
    rvlimit: '1',
    redirects: '1',
  });
}

/** 页面出链（`prop=links`）。 */
export function linksUrl(site, { title, limit, namespace } = {}) {
  return apiUrl(site, {
    action: 'query',
    titles: title,
    prop: 'links',
    pllimit: limit,
    plnamespace: namespace,
    redirects: '1',
  });
}

/** 页面反向链接（`list=backlinks`）。 */
export function backlinksUrl(site, { title, limit, namespace } = {}) {
  return apiUrl(site, {
    action: 'query',
    list: 'backlinks',
    bltitle: title,
    bllimit: limit,
    blnamespace: namespace,
    blredirect: '1',
  });
}

/** 分类成员（`list=categorymembers`）。 */
export function categoryMembersUrl(site, { category, limit, type, aliases } = {}) {
  return apiUrl(site, {
    action: 'query',
    list: 'categorymembers',
    cmtitle: categoryTitle(category, aliases),
    cmlimit: limit,
    cmtype: type,
    cmprop: 'ids|title|type|timestamp',
  });
}

/**
 * 最近改动（`list=recentchanges`）。
 *
 * MediaWiki 没有「最近 N 天」参数，这里换算成 `rcstart`/`rcend` 两个时间戳
 * （ISO 8601 UTC，接口认）。站点时区是 Asia/Shanghai，展示时按本地说法标注。
 * @param {object} site - 站点上下文。
 * @param {{ limit?: number, namespace?: number|string, days?: number, now?: Date }} [options] 参数。
 * @returns {string} 完整 URL。
 */
export function recentChangesUrl(site, { limit, namespace, days = 7, now } = {}) {
  const end = now instanceof Date ? now : new Date();
  const start = new Date(end.getTime() - Math.max(1, Number(days) || 7) * 86_400_000);
  return apiUrl(site, {
    action: 'query',
    list: 'recentchanges',
    rclimit: limit,
    rcnamespace: namespace,
    rcprop: 'title|ids|sizes|flags|user|comment|timestamp',
    rctype: 'edit|new',
    rcstart: end.toISOString(),
    rcend: start.toISOString(),
  });
}

/**
 * `query.pages` 的第一页。`formatversion=2` 下它是数组。
 * @param {any} data - 解析后的 JSON。
 * @returns {any|undefined} 页面对象。
 */
function firstPage(data) {
  return data?.query?.pages?.[0];
}

/**
 * 把 `query.redirects` 里「谁重定向到了这个标题」找出来。
 * @param {any} data - 解析后的 JSON。
 * @param {string} resolvedTitle - 解析后的最终标题。
 * @returns {string[]} 重定向来源标题。
 */
function redirectSources(data, resolvedTitle) {
  const list = data?.query?.redirects;
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => entry?.to === resolvedTitle).map((entry) => String(entry.from));
}

/**
 * 接口返回的 `error` 对象（MediaWiki 形状）。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ code: string, info: string }|undefined} 错误对象；没有错误时为 undefined。
 */
export function mapApiError(data) {
  const error = data?.error;
  if (error === undefined || error === null) return undefined;
  return { code: String(error.code ?? ''), info: String(error.info ?? '') };
}

/**
 * 站点信息与统计。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ sitename: string, generator: string, server: string, articlepath: string, scriptpath: string,
 *   lang: string, mainpage: string, statistics: Record<string, number>,
 *   labels: Record<string, string>, categoryNames: string[] }} 站点概况。
 */
export function mapSiteInfo(data) {
  const general = data?.query?.general ?? {};
  const statistics = data?.query?.statistics ?? {};
  const labels = buildNamespaceLabels(data);
  const categoryNames = new Set(DEFAULT_CATEGORY_NAMES);
  for (const [key, name] of Object.entries(labels)) {
    if (key === '14' && typeof name === 'string' && name !== '') categoryNames.add(name);
  }
  for (const alias of aliasList(data)) categoryNames.add(alias);
  return {
    sitename: String(general.sitename ?? ''),
    generator: String(general.generator ?? ''),
    server: String(general.server ?? ''),
    articlepath: String(general.articlepath ?? ''),
    scriptpath: String(general.scriptpath ?? ''),
    lang: String(general.lang ?? ''),
    mainpage: String(general.mainpage ?? ''),
    statistics,
    labels,
    categoryNames: [...categoryNames],
  };
}

/**
 * siteinfo 的 `namespacealiases` 里的别名列表。
 * @param {any} data - 解析后的 JSON。
 * @returns {string[]} 别名（去重）。
 */
function aliasList(data) {
  const raw = data?.query?.namespacealiases;
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((entry) => String(entry?.alias ?? entry?.['*'] ?? '')).filter((name) => name !== ''))];
}

/**
 * 把 siteinfo 的 `namespaces` 收成 `{id: 名字}`。
 *
 * 兼容两种形状：`formatversion=2` 下它可能是**以 id 为键的对象**（MW 1.37 实测如此），
 * 也可能是数组（每个元素自带 `id`）——两种都认，免得换个版本就静默失效。
 * @param {any} data - 解析后的 JSON。
 * @returns {Record<string, string>} 标签表；拿不到时为空对象。
 */
export function buildNamespaceLabels(data) {
  const raw = data?.query?.namespaces;
  /** @type {Record<string, string>} */
  const labels = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const id = Number(entry?.id);
      if (!Number.isFinite(id)) continue;
      labels[String(id)] = String(entry?.name ?? '');
    }
    return labels;
  }
  if (raw !== null && typeof raw === 'object') {
    for (const [key, entry] of Object.entries(raw)) {
      const id = Number.isFinite(Number(entry?.id)) ? Number(entry.id) : Number(key);
      if (!Number.isFinite(id)) continue;
      labels[String(id)] = String(entry?.name ?? entry?.['*'] ?? '');
    }
  }
  return labels;
}

/**
 * 检索结果。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ totalHits: number|null, hasMore: boolean, offset: number|null,
 *   items: Array<{ ns: number, title: string, pageid?: number, size?: number, wordcount?: number,
 *     timestamp?: string, snippet: string }> }} 归一结果。
 */
export function mapSearch(data) {
  const info = data?.query?.searchinfo ?? {};
  const items = Array.isArray(data?.query?.search) ? data.query.search : [];
  const nextOffset = data?.continue?.sroffset;
  return {
    totalHits: typeof info.totalhits === 'number' ? info.totalhits : null,
    hasMore: nextOffset !== undefined,
    offset: typeof nextOffset === 'number' ? nextOffset : null,
    items: items.map((item) => ({
      ns: Number(item.ns ?? 0),
      title: String(item.title ?? ''),
      pageid: typeof item.pageid === 'number' ? item.pageid : undefined,
      size: typeof item.size === 'number' ? item.size : undefined,
      wordcount: typeof item.wordcount === 'number' ? item.wordcount : undefined,
      timestamp: typeof item.timestamp === 'string' ? item.timestamp : undefined,
      snippet: String(item.snippet ?? ''),
    })),
  };
}

/**
 * 前缀候选（`list=prefixsearch`）。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ items: Array<{ ns: number, title: string, pageid?: number }>, hasMore: boolean }} 结果。
 */
export function mapPrefixSearch(data) {
  const items = Array.isArray(data?.query?.prefixsearch) ? data.query.prefixsearch : [];
  return {
    items: items.map((item) => ({
      ns: Number(item.ns ?? 0),
      title: String(item.title ?? ''),
      pageid: typeof item.pageid === 'number' ? item.pageid : undefined,
    })),
    hasMore: data?.continue?.psoffset !== undefined,
  };
}

/**
 * 前缀枚举（`list=allpages`）。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ items: Array<{ title: string, pageid?: number }>, hasMore: boolean }} 结果。
 */
export function mapAllPages(data) {
  const items = Array.isArray(data?.query?.allpages) ? data.query.allpages : [];
  return {
    items: items.map((item) => ({
      title: String(item.title ?? ''),
      pageid: typeof item.pageid === 'number' ? item.pageid : undefined,
    })),
    hasMore: data?.continue?.apcontinue !== undefined,
  };
}

/**
 * `action=parse&prop=text` 的结果。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ title: string, pageid?: number, revid?: number, html: string }} 结果。
 */
export function mapPageText(data) {
  const parse = data?.parse ?? {};
  return {
    title: String(parse.title ?? ''),
    pageid: typeof parse.pageid === 'number' ? parse.pageid : undefined,
    revid: typeof parse.revid === 'number' ? parse.revid : undefined,
    html: typeof parse.text === 'string' ? parse.text : '',
  };
}

/**
 * `action=parse&prop=wikitext` 的结果。
 *
 * 提醒：PRTS 的干员/材料页正文大量在被引用的模板与 SMW 数据里，wikitext 往往只有模板调用；
 * 要读正文请用 `format="text"`。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ title: string, pageid?: number, revid?: number, content: string }} 结果。
 */
export function mapWikitext(data) {
  const parse = data?.parse ?? {};
  return {
    title: String(parse.title ?? ''),
    pageid: typeof parse.pageid === 'number' ? parse.pageid : undefined,
    revid: typeof parse.revid === 'number' ? parse.revid : undefined,
    content: typeof parse.wikitext === 'string' ? parse.wikitext : '',
  };
}

/**
 * 页面元数据。
 * @param {any} data - 解析后的 JSON。
 * @param {{ categoryNames?: string[] }} [options] - 分类命名空间别名。
 * @returns {{ found: boolean, title: string, missing: boolean, pageid?: number, ns?: number,
 *   length?: number, touched?: string, lastrevid?: number, fullurl?: string, displaytitle?: string,
 *   redirectFrom: string[], isRedirect: boolean, categories: string[], pageprops: Record<string, unknown>,
 *   lastEdit: { revid?: number, timestamp?: string, user?: string, comment?: string } }} 结果。
 */
export function mapPageInfo(data, options = {}) {
  const page = firstPage(data) ?? {};
  const title = String(page.title ?? '');
  const pageprops = page.pageprops && typeof page.pageprops === 'object' ? page.pageprops : {};
  const aliases = options.categoryNames ?? DEFAULT_CATEGORY_NAMES;
  const categories = Array.isArray(page.categories)
    ? page.categories
      .map((entry) => stripCategoryPrefix(String(entry.title ?? ''), aliases))
      .filter((name) => name !== '')
    : [];
  const revision = Array.isArray(page.revisions) ? page.revisions[0] ?? {} : {};
  return {
    found: page.missing !== true && typeof page.pageid === 'number',
    title,
    missing: page.missing === true,
    pageid: typeof page.pageid === 'number' ? page.pageid : undefined,
    ns: typeof page.ns === 'number' ? page.ns : undefined,
    length: typeof page.length === 'number' ? page.length : undefined,
    touched: typeof page.touched === 'string' ? page.touched : undefined,
    lastrevid: typeof page.lastrevid === 'number' ? page.lastrevid : undefined,
    fullurl: typeof page.fullurl === 'string' ? page.fullurl : undefined,
    displaytitle: typeof page.displaytitle === 'string' ? page.displaytitle : undefined,
    redirectFrom: redirectSources(data, title),
    isRedirect: typeof page.redirect === 'string' || page.redirect === true,
    categories,
    pageprops,
    lastEdit: {
      revid: typeof revision.revid === 'number' ? revision.revid : undefined,
      timestamp: typeof revision.timestamp === 'string' ? revision.timestamp : undefined,
      user: typeof revision.user === 'string' ? revision.user : undefined,
      comment: typeof revision.comment === 'string' ? revision.comment : undefined,
    },
  };
}

/**
 * 出链（`prop=links`）。
 * @param {any} data - 解析后的 JSON。
 * @param {string} requestedTitle - 调用方给的标题（用于在响应里找回对应页面）。
 * @returns {{ found: boolean, title: string, links: Array<{ ns: number, title: string }> }} 结果。
 */
export function mapLinks(data, requestedTitle = '') {
  const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
  const page = pages.find((entry) => entry?.title === requestedTitle) ?? pages[0] ?? {};
  const links = Array.isArray(page.links) ? page.links : [];
  return {
    found: page.missing !== true && typeof page.pageid === 'number',
    title: String(page.title ?? ''),
    links: links.map((link) => ({ ns: Number(link.ns ?? 0), title: String(link.title ?? '') })),
  };
}

/**
 * 反向链接（`list=backlinks`）。
 * @param {any} data - 解析后的 JSON。
 * @returns {Array<{ pageid?: number, ns: number, title: string, redirect: boolean }>} 结果。
 */
export function mapBacklinks(data) {
  const items = Array.isArray(data?.query?.backlinks) ? data.query.backlinks : [];
  return items.map((item) => ({
    pageid: typeof item.pageid === 'number' ? item.pageid : undefined,
    ns: Number(item.ns ?? 0),
    title: String(item.title ?? ''),
    redirect: item.redirect === true,
  }));
}

/**
 * 分类成员。
 * @param {any} data - 解析后的 JSON。
 * @returns {Array<{ pageid?: number, ns: number, title: string, type: string, timestamp?: string }>} 结果。
 */
export function mapCategoryMembers(data) {
  const items = Array.isArray(data?.query?.categorymembers) ? data.query.categorymembers : [];
  return items.map((item) => ({
    pageid: typeof item.pageid === 'number' ? item.pageid : undefined,
    ns: Number(item.ns ?? 0),
    title: String(item.title ?? ''),
    type: String(item.type ?? (item.ns === 14 ? 'subcat' : item.ns === 6 ? 'file' : 'page')),
    timestamp: typeof item.timestamp === 'string' ? item.timestamp : undefined,
  }));
}

/**
 * 最近改动。
 * @param {any} data - 解析后的 JSON。
 * @returns {Array<{ type: string, ns: number, title: string, user: string, timestamp: string,
 *   comment: string, oldlen?: number, newlen?: number, revid?: number, redirect: boolean }>} 结果。
 */
export function mapRecentChanges(data) {
  const items = Array.isArray(data?.query?.recentchanges) ? data.query.recentchanges : [];
  return items.map((item) => ({
    type: String(item.type ?? 'edit'),
    ns: Number(item.ns ?? 0),
    title: String(item.title ?? ''),
    user: String(item.user ?? ''),
    timestamp: String(item.timestamp ?? ''),
    comment: String(item.comment ?? ''),
    oldlen: typeof item.oldlen === 'number' ? item.oldlen : undefined,
    newlen: typeof item.newlen === 'number' ? item.newlen : undefined,
    revid: typeof item.revid === 'number' ? item.revid : undefined,
    redirect: item.redirect === true,
  }));
}

export { pageUrl };
