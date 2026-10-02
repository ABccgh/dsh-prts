/**
 * dsh-prts 的 Cordis 插件入口。
 *
 * 把 **PRTS**（<https://prts.wiki>，明日方舟中文 Wiki，MediaWiki 1.43）接进 DSH，注册
 * **9 个只读工具**：
 *
 * - 发现：`prts_status`、`prts_search`、`prts_titles`
 * - 页面：`prts_page`、`prts_sections`、`prts_page_info`
 * - 导航：`prts_links`、`prts_category`、`prts_recent_changes`
 *
 * 全部只读：不改 wiki 内容、不需要登录、不需要任何密钥（该站 `writeapi=false`）。
 *
 * **本模块刻意不 import 任何 `@deepseek-ai/*` 包。** 插件是 `link:` 安装的 profile bundle，
 * 代码在 DSH 安装作用域之外，DSH 的 profile 解析路由不会把 bundle 里的 `@deepseek-ai/*`
 * 导入重定向到安装目录——一旦 import 就会让整个插件以 ERR_MODULE_NOT_FOUND 加载失败。
 * 同理这里不导出 `Config`：`resolveConfig` 在没有 `Config` 时会原样透传配置对象，
 * 校验与默认值由下面的 `normalizeConfig` 负责。
 *
 * @module @local/prts
 */

import { createHttpClient, ensureSystemCaTrusted, systemCaStatus } from './http.js';
import { DEFAULT_DROP_CLASSES, DEFAULT_DROP_CLASS_PREFIXES, DEFAULT_NOISE_PATTERNS } from './html-text.js';
import { DEFAULT_SITE, createSite, normalizeApiPath, normalizeArticlePath, normalizeBaseUrl } from './sites.js';
import { createSiteMeta } from './site-meta.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerNavigateTools } from './tools/navigate.js';
import { registerPageTools } from './tools/page.js';
import { createJsonReader } from './tools/shared.js';

/** 插件名，也是 loader row 的 `name` 里 App 面的标识。 */
export const name = 'prts';

/** 工具注册表是本插件的硬依赖；`web` 只在兜底时用可选注入。 */
export const inject = ['tools'];

/** 默认 User-Agent：该站未见反爬拦截图，仍按 MediaWiki 的 UA 政策写成「名字 + 联系地址」。 */
const DEFAULT_USER_AGENT = 'dsh-prts/0.1 (+https://github.com/ABccgh/dsh-prts; read-only)';

/** `trustSystemCa` 的合法取值。 */
const CA_MODES = new Set(['auto', 'always', 'never']);

/**
 * 把 loader 传来的配置收进合法范围。
 *
 * 这里不抛错：一个写错的字段不应该让整个插件装不上，回退到默认值并留一行日志更合适。
 *
 * | 字段 | 默认 | 说明 |
 * | --- | --- | --- |
 * | `wikiBaseUrl` | `https://prts.wiki` | 站点根 URL |
 * | `apiPath` | `/api.php` | 接口路径（该站 `scriptpath` 为空，接口在根路径） |
 * | `articlePath` | `/w/$1` | 文章路径模板（该站是 `/w/<标题>`） |
 * | `userAgent` | `dsh-prts/0.1 (+…; read-only)` | 保留「名字 + 联系地址」的机器人写法 |
 * | `requestTimeoutMs` | `20000` | 单次 HTTP 超时 |
 * | `maxChars` | `20000` | 页面文本默认截断上限（单页 HTML 实测 443 KB） |
 * | `maxListedItems` | `50` | 列表类工具硬上限 |
 * | `cacheTtlMs` | `300000` | 只读结果 TTL 缓存（含单飞去重），`0` 关闭 |
 * | `cacheMaxEntries` | `24` | 缓存条数（LRU） |
 * | `throttleAttempts` | `3` | 遇到 5xx / 非 JSON 响应时的总尝试次数 |
 * | `throttleBaseDelayMs` | `1200` | 退避基数：第 n 次等待 n × 这个值 |
 * | `throttleMaxWaitMs` | `10000` | 一次调用里退避等待的总上限 |
 * | `trustSystemCa` | `auto` | `auto` / `always` / `never` |
 * | `webFallback` | `true` | 直连失败时是否用 DSH `web` 服务再取一次 |
 * | `keepImages` | `false` | 是否在正文里保留 `[图: alt]`（单页 183 张图，默认关） |
 * | `dropClasses` / `dropClassPrefixes` / `noisePatterns` | 见 `html-text.js` | 站点噪声表 |
 *
 * @param {Record<string, unknown>} raw - loader 校验后的配置。
 * @returns {Record<string, any>} 生效配置。
 */
export function normalizeConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback);
  const nonNegative = (value, fallback) => (Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback);
  const stringList = (value, fallback) => {
    if (!Array.isArray(value)) return [...fallback];
    return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  };

  const rawBase = typeof source.wikiBaseUrl === 'string' ? source.wikiBaseUrl.trim() : '';
  const baseUrl = normalizeBaseUrl(rawBase) || DEFAULT_SITE.baseUrl;
  const configWarnings = [];
  if (rawBase !== '' && normalizeBaseUrl(rawBase) === '') {
    configWarnings.push(`wikiBaseUrl=${rawBase} 看起来不是 http(s) 地址，已回退到 ${DEFAULT_SITE.baseUrl}。`);
  }
  const rawArticlePath = typeof source.articlePath === 'string' ? source.articlePath.trim() : '';

  return {
    wikiBaseUrl: baseUrl,
    apiPath: normalizeApiPath(source.apiPath),
    // 没配就用本站出厂值（`/w/$1`）；配了但缺 `$1` 才退回「由 baseUrl 推导」。
    articlePath: rawArticlePath === '' ? DEFAULT_SITE.articlePath : normalizeArticlePath(rawArticlePath, baseUrl),
    configWarnings,
    userAgent: text(source.userAgent, DEFAULT_USER_AGENT),
    requestTimeoutMs: positive(source.requestTimeoutMs, 20_000),
    maxChars: positive(source.maxChars, 20_000),
    maxListedItems: positive(source.maxListedItems, 50),
    cacheTtlMs: nonNegative(source.cacheTtlMs, 300_000),
    cacheMaxEntries: positive(source.cacheMaxEntries, 24),
    throttleAttempts: Math.min(6, positive(source.throttleAttempts, 3)),
    throttleBaseDelayMs: nonNegative(source.throttleBaseDelayMs, 1200),
    throttleMaxWaitMs: nonNegative(source.throttleMaxWaitMs, 10_000),
    trustSystemCa: CA_MODES.has(source.trustSystemCa) ? String(source.trustSystemCa) : 'auto',
    webFallback: source.webFallback !== false,
    keepImages: source.keepImages === true,
    dropClasses: stringList(source.dropClasses, DEFAULT_DROP_CLASSES),
    dropClassPrefixes: stringList(source.dropClassPrefixes, DEFAULT_DROP_CLASS_PREFIXES),
    noisePatterns: stringList(source.noisePatterns, DEFAULT_NOISE_PATTERNS),
  };
}

/**
 * 装配插件。
 *
 * @param {object} ctx - Cordis 上下文（硬依赖 `tools`，可选 `web`、`logger`）。
 * @param {Record<string, unknown>} config - loader 校验后的配置。
 * @param {{ fetchImpl?: Function }} [overrides] - 测试用接缝：替换出网实现（生产路径不传）。
 * @returns {Promise<void>} 无。
 *
 * 注意**不要返回任何值**：Cordis 会把 `apply` 的返回值当成 effect 去收集，
 * 返回字符串数组会以「Invalid effect」让整个插件激活失败。已注册的工具名只用于日志。
 */
export async function apply(ctx, config, overrides = {}) {
  const effective = normalizeConfig(config);

  /** 记一行日志；日志不可用不该影响插件本身。 */
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[prts] ${message}`);
    } catch {
      // 日志失败无所谓。
    }
  };

  for (const warning of effective.configWarnings) log('warn', warning);

  const site = createSite(effective);

  const http = createHttpClient({
    timeoutMs: effective.requestTimeoutMs,
    userAgent: effective.userAgent,
    trustSystemCa: effective.trustSystemCa,
    throttleAttempts: effective.throttleAttempts,
    throttleBaseDelayMs: effective.throttleBaseDelayMs,
    throttleMaxWaitMs: effective.throttleMaxWaitMs,
    webFallback: effective.webFallback,
    fetchImpl: overrides.fetchImpl,
    getWeb: () => ctx.get?.('web'),
  });

  const reader = createJsonReader(http, { ttlMs: effective.cacheTtlMs, maxEntries: effective.cacheMaxEntries });
  const siteMeta = createSiteMeta(reader);

  /** 插件级诊断状态：`prts_status` 会把最近一次探测结果回报出来。 */
  const state = {
    /** @type {{ at: string, ok: boolean, via?: string, attempts?: number, server?: string,
     *   error?: string, unexpectedBody?: boolean }|undefined} */
    lastProbe: undefined,
    systemCa: systemCaStatus(),
  };

  const deps = { config: effective, site, reader, state, log, siteMeta };

  const names = [
    ...registerDiscoveryTools(ctx, effective, deps),
    ...registerPageTools(ctx, effective, deps),
    ...registerNavigateTools(ctx, effective, deps),
  ];

  if (effective.trustSystemCa === 'always') {
    const ca = ensureSystemCaTrusted();
    log(
      'info',
      ca.error === undefined
        ? `trustSystemCa=always：已并入系统根证书（+${ca.added}，共 ${ca.total}）。`
        : `trustSystemCa=always：并入系统根证书失败——${ca.error}`,
    );
  }

  log(
    'info',
    `就绪：${names.length} 个只读工具；站点 ${site.baseUrl}${site.apiPath}，文章路径 ${site.articlePath}，`
    + `缓存 TTL ${effective.cacheTtlMs} ms（${effective.cacheMaxEntries} 条），重试 ${effective.throttleAttempts} 次，`
    + `webFallback=${effective.webFallback ? 'on' : 'off'}，trustSystemCa=${effective.trustSystemCa}。`,
  );
}
