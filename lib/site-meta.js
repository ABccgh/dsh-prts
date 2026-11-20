/**
 * 站点元数据缓存：懒加载一次 `siteinfo`，供命名空间名字解析、命名空间标签与分类别名使用。
 *
 * 为什么要单独一层：PRTS 的命名空间是**本地化**的——`14` 叫 `分类` 而不是 `Category`、
 * `4` 是 `PRTS`、`274` 是 `微件`、`828` 是 `模块`，而且名字/别名必须先经 siteinfo 才能
 * 变成数字 id（接口只认数字）。所以「检索的 namespace 写名字」「分类成员」「出链」
 * 这些路径都得先问一次 siteinfo。
 *
 * 缓存策略：
 * - **10 分钟 TTL**：siteinfo 基本不变，但站点偶尔新增命名空间/别名，长时间运行
 *   不能永远用旧表；工具传 `fresh: true` 时绕过（`prts_links` / `prts_category` /
 *   `prts_page_info` / `prts_search` 都会透传 `fresh`）。
 * - 失败的探测**不写缓存**（下一次会重试），并沿用旧值，不至于因为一次 CDN 拦截
 *   就把标签退化成内置兜底表。
 *
 * @module dsh-prts/site-meta
 */

import { mapSiteInfo, siteInfoUrl } from './mediawiki.js';

/** 默认 TTL：10 分钟。 */
export const SITE_META_TTL_MS = 600_000;

/**
 * 造一个站点元数据读取器。
 * @param {{ read: Function }} reader - URL 级缓存读取器。
 * @param {{ ttlMs?: number, now?: () => number }} [options] - TTL 与时钟（测试用注入）。
 * @returns {{ get: (site: object, options?: { signal?: AbortSignal, fresh?: boolean }) => Promise<object|undefined> }}
 *   读取器。
 */
export function createSiteMeta(reader, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, Math.trunc(options.ttlMs)) : SITE_META_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** @type {Map<string, { meta: object, at: number }>} */
  const cache = new Map();

  return {
    async get(site, readOptions = {}) {
      const entry = cache.get(site.key);
      const fresh = readOptions.fresh === true;
      if (entry !== undefined && !fresh && now() - entry.at < ttlMs) return entry.meta;

      const result = await reader.read(siteInfoUrl(site), { signal: readOptions.signal, fresh });
      // 失败时沿用旧值（哪怕已过期）：标签退化比整个工具报错更糟。
      if (result?.ok !== true) return entry?.meta;

      const at = now();
      const meta = {
        ...mapSiteInfo(result.data),
        key: site.key,
        url: siteInfoUrl(site),
        via: result.via,
        attempts: result.attempts,
        server: result.server,
        at,
      };
      cache.set(site.key, { meta, at });
      return meta;
    },
  };
}
