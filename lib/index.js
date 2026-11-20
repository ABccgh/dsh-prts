/**
 * dsh-prts 的 Cordis 插件入口。
 *
 * 把 **PRTS**（<https://prts.wiki>，明日方舟中文 Wiki，MediaWiki 1.43）接进 DSH，注册
 * **10 个只读工具**：
 *
 * - 发现：`prts_status`、`prts_search`、`prts_titles`
 * - 页面：`prts_page`、`prts_sections`、`prts_page_info`
 * - 导航：`prts_links`、`prts_category`、`prts_recent_changes`
 * - 档案：`prts_operator`（解析干员页 wikitext 里的 CharinfoV2/干员获得方式/属性模板）
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

import { createHttpClient, ensureSystemCaTrusted } from './http.js';
import { DEFAULT_DROP_CLASSES, DEFAULT_DROP_CLASS_PREFIXES, DEFAULT_NOISE_PATTERNS } from './html-text.js';
import { DEFAULT_SITE, createSite, normalizeApiPath, normalizeArticlePath, normalizeBaseUrl } from './sites.js';
import { createSiteMeta } from './site-meta.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerNavigateTools } from './tools/navigate.js';
import { registerOperatorTools } from './tools/operator.js';
import { registerPageTools } from './tools/page.js';
import { createJsonReader } from './tools/shared.js';

/** 插件名，也是 loader row 的 `name` 里 App 面的标识。 */
export const name = 'prts';

/** 工具注册表是本插件的硬依赖；`web` 只在兜底时用可选注入。 */
export const inject = ['tools'];

/** 默认 User-Agent：该站未见反爬拦截图，仍按 MediaWiki 的 UA 政策写成「名字 + 联系地址」。 */
const DEFAULT_USER_AGENT = 'dsh-prts/1.1.0 (+https://github.com/ABccgh/dsh-prts; read-only)';

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
 * | `userAgent` | `dsh-prts/1.1.0 (+…; read-only)` | 保留「名字 + 联系地址」的机器人写法 |
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
  /** @type {string[]} */
  const configWarnings = [];
  /** 字段被拒时统一记一条告警：值、期望、回退结果都写清楚。 */
  const reject = (field, value, expected, fallbackText) => {
    const shown = typeof value === 'string' ? JSON.stringify(value) : Array.isArray(value) ? '数组' : String(value);
    configWarnings.push(`配置字段 ${field}=${shown} 不合法（${expected}），已回退到 ${fallbackText}。`);
  };
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const numberField = (field, value, fallback, { positive = false, max } = {}) => {
    if (value === undefined || value === null) return fallback;
    const valid = typeof value === 'number' && Number.isFinite(value)
      && (positive ? value > 0 : value >= 0);
    const expected = positive ? '应为大于 0 的整数' : '应为不小于 0 的整数';
    if (!valid) {
      reject(field, value, expected, String(fallback));
      return fallback;
    }
    const clipped = Math.trunc(value);
    if (max !== undefined && clipped > max) {
      configWarnings.push(`配置字段 ${field}=${value} 超过上限 ${max}，已夹紧到 ${max}。`);
      return max;
    }
    return clipped;
  };
  const stringList = (field, value, fallback) => {
    if (value === undefined || value === null) return [...fallback];
    if (!Array.isArray(value)) {
      reject(field, value, '应为字符串数组', fallback.length === 0 ? '空表' : `${fallback.length} 项默认值`);
      return [...fallback];
    }
    const kept = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
    const dropped = value.length - kept.length;
    if (dropped > 0) {
      configWarnings.push(`配置字段 ${field} 里有 ${dropped} 项不是非空字符串，已忽略（保留 ${kept.length} 项）。`);
    }
    return kept;
  };

  const rawBase = source.wikiBaseUrl === undefined || source.wikiBaseUrl === null ? '' : String(source.wikiBaseUrl).trim();
  const baseUrl = normalizeBaseUrl(rawBase) || DEFAULT_SITE.baseUrl;
  if (rawBase !== '' && normalizeBaseUrl(rawBase) === '') {
    configWarnings.push(`wikiBaseUrl=${rawBase} 看起来不是 http(s) 地址，已回退到 ${DEFAULT_SITE.baseUrl}。`);
  }

  const rawApiPath = source.apiPath;
  if (rawApiPath !== undefined && rawApiPath !== null && (typeof rawApiPath !== 'string' || rawApiPath.trim() === '')) {
    reject('apiPath', rawApiPath, '应为非空字符串', DEFAULT_SITE.apiPath);
  }

  const rawArticlePath = source.articlePath === undefined || source.articlePath === null ? '' : String(source.articlePath).trim();
  if (rawArticlePath !== '' && !rawArticlePath.includes('$1')) {
    reject('articlePath', source.articlePath, '应包含 $1 占位符', `由 wikiBaseUrl 推导的 ${normalizeArticlePath('', baseUrl)}`);
  }

  if (source.userAgent !== undefined && source.userAgent !== null
    && (typeof source.userAgent !== 'string' || source.userAgent.trim() === '')) {
    reject('userAgent', source.userAgent, '应为非空字符串', DEFAULT_USER_AGENT);
  }

  let trustSystemCa = 'auto';
  if (source.trustSystemCa !== undefined && source.trustSystemCa !== null) {
    if (CA_MODES.has(source.trustSystemCa)) trustSystemCa = String(source.trustSystemCa);
    else reject('trustSystemCa', source.trustSystemCa, '只能是 auto / always / never', 'auto');
  }

  if (source.webFallback !== undefined && source.webFallback !== null && typeof source.webFallback !== 'boolean') {
    reject('webFallback', source.webFallback, '应为布尔值', 'true');
  }
  if (source.keepImages !== undefined && source.keepImages !== null && typeof source.keepImages !== 'boolean') {
    reject('keepImages', source.keepImages, '应为布尔值', 'false');
  }

  const dropClasses = stringList('dropClasses', source.dropClasses, DEFAULT_DROP_CLASSES);
  const dropClassPrefixes = stringList('dropClassPrefixes', source.dropClassPrefixes, DEFAULT_DROP_CLASS_PREFIXES);
  const noisePatterns = stringList('noisePatterns', source.noisePatterns, DEFAULT_NOISE_PATTERNS);
  for (const pattern of noisePatterns) {
    try {
      new RegExp(pattern);
    } catch {
      configWarnings.push(`配置字段 noisePatterns 里的 ${JSON.stringify(pattern)} 不是合法正则，运行时会被忽略。`);
    }
  }

  return {
    wikiBaseUrl: baseUrl,
    apiPath: normalizeApiPath(source.apiPath),
    // 没配就用本站出厂值（`/w/$1`）；配了但缺 `$1` 才退回「由 baseUrl 推导」。
    articlePath: rawArticlePath === '' ? DEFAULT_SITE.articlePath : normalizeArticlePath(rawArticlePath, baseUrl),
    configWarnings,
    userAgent: text(source.userAgent, DEFAULT_USER_AGENT),
    requestTimeoutMs: numberField('requestTimeoutMs', source.requestTimeoutMs, 20_000, { positive: true }),
    maxChars: numberField('maxChars', source.maxChars, 20_000, { positive: true }),
    maxListedItems: numberField('maxListedItems', source.maxListedItems, 50, { positive: true }),
    cacheTtlMs: numberField('cacheTtlMs', source.cacheTtlMs, 300_000),
    cacheMaxEntries: numberField('cacheMaxEntries', source.cacheMaxEntries, 24, { positive: true }),
    throttleAttempts: numberField('throttleAttempts', source.throttleAttempts, 3, { positive: true, max: 6 }),
    throttleBaseDelayMs: numberField('throttleBaseDelayMs', source.throttleBaseDelayMs, 1200),
    throttleMaxWaitMs: numberField('throttleMaxWaitMs', source.throttleMaxWaitMs, 10_000),
    trustSystemCa,
    webFallback: source.webFallback !== false,
    keepImages: source.keepImages === true,
    dropClasses,
    dropClassPrefixes,
    noisePatterns,
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

  const deps = { config: effective, site, reader, log, siteMeta };

  const names = [
    ...registerDiscoveryTools(ctx, effective, deps),
    ...registerPageTools(ctx, effective, deps),
    ...registerNavigateTools(ctx, effective, deps),
    ...registerOperatorTools(ctx, effective, deps),
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
