/**
 * 站点元数据缓存：懒加载一次 `siteinfo`，供命名空间标签与分类别名使用。
 *
 * 为什么要单独一层：PRTS 的命名空间是**本地化**的——`14` 叫 `分类` 而不是 `Category`、
 * `4` 是 `PRTS`、`274` 是 `微件`、`828` 是 `模块`，所以「分类成员」「出链」这些输出想要
 * 可读的命名空间标签，就得先问一次 siteinfo。问一次就够：结果缓存住，
 * 下面 `reader` 再按 URL 缓存一层，正常一轮对话最多一次请求。
 *
 * 失败的探测**不写缓存**（下一次会重试），并且沿用旧值，不至于因为一次 CDN 拦截
 * 就把标签退化成内置兜底表。
 *
 * @module dsh-prts/site-meta
 */

import { mapSiteInfo, siteInfoUrl } from './mediawiki.js';

/**
 * 造一个站点元数据读取器。
 * @param {{ read: Function }} reader - URL 级缓存读取器。
 * @returns {{ get: (site: object, options?: { signal?: AbortSignal, fresh?: boolean }) => Promise<object|undefined>,
 *   peek: (key: string) => object|undefined }} 读取器。
 */
export function createSiteMeta(reader) {
  /** @type {Map<string, object>} */
  const cache = new Map();

  return {
    async get(site, options = {}) {
      const cached = cache.get(site.key);
      if (cached !== undefined && options.fresh !== true) return cached;

      const result = await reader.read(siteInfoUrl(site), { signal: options.signal, fresh: options.fresh === true });
      if (result?.ok !== true) return cached;

      const info = mapSiteInfo(result.data);
      const meta = {
        ...info,
        key: site.key,
        url: siteInfoUrl(site),
        via: result.via,
        attempts: result.attempts,
        server: result.server,
        at: Date.now(),
      };
      cache.set(site.key, meta);
      return meta;
    },
    peek(key) {
      return cache.get(key);
    },
  };
}
