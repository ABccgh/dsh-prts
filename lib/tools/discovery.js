/**
 * 发现类工具：站点自检（`prts_status`）、全文检索（`prts_search`）、标题候选（`prts_titles`）。
 *
 * 关于检索：PRTS 用的是 **MediaWiki 内置搜索后端**（实测没有 CirrusSearch），所以
 * `intitle:` / `incategory:` / `insource:` 这类 CirrusSearch 语法**不可用**
 * （实测 `intitle:阿米娅` 返回 0 命中，而普通 `阿米娅` 返回 28），
 * 而且片段是 **wikitext 原文**形态（`|名称=… |用途=…`）——工具描述里如实写明，片段做最小归约。
 *
 * @module dsh-prts/tools/discovery
 */

import {
  allPagesUrl,
  mapAllPages,
  mapPrefixSearch,
  mapSearch,
  mapSiteInfo,
  pageUrl,
  prefixSearchUrl,
  searchUrl,
  siteInfoUrl,
} from '../mediawiki.js';
import { cleanSnippet } from '../html-text.js';
import { systemCaStatus } from '../http.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT, alwaysSafe, apiErrorText, clampInt, clampLimit, formatAge, header, listTail,
  namespaceParam, requireText, titleWithNs, unwrap,
} from './shared.js';

/**
 * 注册 3 个发现类工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {Record<string, any>} config - 生效配置。
 * @param {{ site: object, reader: { read: Function, stats: Function }, state: Record<string, any>,
 *   siteMeta: { get: Function } }} deps - 依赖。
 * @returns {string[]} 已注册的工具名。
 */
export function registerDiscoveryTools(ctx, config, deps) {
  const { site, reader, state, siteMeta } = deps;

  ctx.tools.register(
    defineTool({
      name: 'prts_status',
      description:
        '检查 PRTS（prts.wiki，明日方舟 Wiki）的连通性与站点概况：站点名、MediaWiki 版本、接口地址、'
        + '页面统计、通道（直连/DSH web 兜底）、重试与缓存、证书状态。任何 prts 工具报错时先调它定位问题。只读。',
      parameters: {
        fresh: { type: 'boolean', description: '为 true 时绕过缓存，强制访问一次线上接口（默认 false）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const url = siteInfoUrl(site);
        const result = await reader.read(url, { signal: exec.signal, fresh: args.fresh === true });
        state.lastProbe = {
          at: new Date().toISOString(),
          ok: result?.ok === true,
          via: result?.via,
          attempts: result?.attempts,
          server: result?.server,
          error: result?.ok === true ? undefined : result?.error,
          unexpectedBody: result?.unexpectedBody === true,
        };
        const ca = systemCaStatus();
        const stats = reader.stats();
        const configLines = [
          `配置：wikiBaseUrl=${config.wikiBaseUrl}，apiPath=${config.apiPath}，articlePath=${config.articlePath}，`
          + `maxChars=${config.maxChars}，maxListedItems=${config.maxListedItems}，超时 ${config.requestTimeoutMs} ms，`
          + `缓存 TTL ${config.cacheTtlMs} ms（${config.cacheMaxEntries} 条，LRU），`
          + `webFallback=${config.webFallback ? 'on' : 'off'}，重试 ${config.throttleAttempts} 次/退避 ${config.throttleBaseDelayMs} ms`,
          `User-Agent：${config.userAgent}`,
          `系统 CA：${ca.merged ? `已并入（+${ca.added}，共 ${ca.total}）` : `未合并${ca.error === undefined ? '（遇到证书错误才会合并）' : `（失败：${ca.error}）`}`}`,
          `缓存：命中 ${stats.hits} / 未命中 ${stats.misses}，当前 ${stats.size} 条`,
        ];

        if (result?.ok !== true) {
          return {
            text: [
              'PRTS 连通失败。',
              result?.error ?? '未知错误',
              typeof result?.hint === 'string' && result.hint !== '' ? `建议：${result.hint}` : '',
              typeof result?.server === 'string' ? `最近一次响应头 server=${result.server}，已尝试 ${result.attempts ?? 1} 次。` : '',
              ...configLines,
            ].filter((line) => line !== '').join('\n'),
          };
        }

        const rejected = apiErrorText(result.data, '读取站点信息');
        if (rejected !== '') return { text: [rejected, `接口：${url}`, ...configLines].join('\n') };

        const info = mapSiteInfo(result.data);
        const s = info.statistics ?? {};
        const number = (value) => (typeof value === 'number' ? String(value) : '-');
        return {
          text: [
            'PRTS 连通正常。',
            `站点：${info.sitename}（${info.generator}），语言 ${info.lang}，首页「${info.mainpage}」`,
            `接口：${url}`,
            `通道：${result.via === 'dsh-web' ? 'DSH web 服务兜底' : '直连'}，尝试 ${result.attempts ?? 1} 次`
            + `${typeof result.server === 'string' ? `，server=${result.server}` : ''}`,
            `统计：页面 ${number(s.pages)}，条目 ${number(s.articles)}，编辑 ${number(s.edits)}，`
            + `文件 ${number(s.images)}，用户 ${number(s.users)}，活跃用户 ${number(s.activeusers)}`,
            ...configLines,
          ].join('\n'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'prts_search',
      description:
        '在 PRTS 做全文检索（该站用的是 **MediaWiki 内置搜索**，没有 CirrusSearch——'
        + '`intitle:` / `incategory:` / `insource:` 这类语法在这里不可用，请用自然关键词）。'
        + '返回标题、pageid、字节数、最后编辑与命中片段（片段是 wikitext 原文，已做最小归约）。'
        + '要读正文请用 prts_page（长页面先 prts_sections）。只读。',
      parameters: {
        query: { type: 'string', required: true, description: '检索关键词，例如 "能天使 信物"；不支持 CirrusSearch 语法。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 10，上限 ${config.maxListedItems}。` },
        namespace: { type: 'string', description: '命名空间 id 或名字，默认 0（主条目）；传 * 表示全部。' },
        offset: { type: 'integer', description: '从第几条开始（翻页用），默认 0。' },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const query = requireText(args.query, 'query');
        const limit = clampLimit(args.limit, 10, config.maxListedItems);
        const offset = Math.max(0, clampInt(args.offset, 0));
        const ns = namespaceParam(args.namespace, 0);
        const url = searchUrl(site, { query, limit, offset, namespace: ns });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '检索');
        const rejected = apiErrorText(data, '检索');
        if (rejected !== '') return { text: `${rejected}\n请求：${url}` };
        const mapped = mapSearch(data);

        if (mapped.items.length === 0) {
          return {
            text: [
              `检索「${query}」没有命中（命名空间 ${ns}）。`,
              '可试：换更短的关键词、把 namespace 传 * 搜全部命名空间，或用 prts_titles 按前缀找标题；'
              + '本站没有 CirrusSearch，intitle:/incategory:/insource: 这类语法不起作用。',
              `请求：${url}`,
            ].join('\n'),
          };
        }

        const labels = (await siteMeta.get(site, { signal: exec.signal }))?.labels;
        const lines = mapped.items.map((item, index) => {
          const meta = [
            item.pageid === undefined ? '' : `pageid ${item.pageid}`,
            item.size === undefined ? '' : `${item.size} 字节`,
            item.timestamp === undefined ? '' : formatAge(item.timestamp),
          ].filter((part) => part !== '').join('，');
          const snippet = cleanSnippet(item.snippet);
          return `${offset + index + 1}. ${titleWithNs(item.title, item.ns, labels)}${meta === '' ? '' : `（${meta}）`}`
            + `${snippet === '' ? '' : `\n   ${snippet}`}`;
        });
        const nextOffset = mapped.offset ?? offset + mapped.items.length;
        return {
          text: `检索「${query}」：${mapped.totalHits === null ? '' : `共 ${mapped.totalHits} 条命中，`}`
            + `本次 ${mapped.items.length} 条（命名空间 ${ns}）\n`
            + lines.join('\n')
            + listTail(mapped.items.length, null, '条', mapped.hasMore ? `下一页用 offset=${nextOffset}` : '已到末尾'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'prts_titles',
      description:
        '按前缀猜页面标题，把名字对准后再交给 prts_page。返回标题、命名空间与规范 URL'
        + '（先试 prefixsearch，空结果回退 allpages 前缀枚举）。只读。',
      parameters: {
        query: { type: 'string', required: true, description: '标题前缀，例如 "阿米娅" 或 "龙门"。' },
        limit: { type: 'integer', description: '最多返回多少条，默认 10，上限 20。' },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const query = requireText(args.query, 'query');
        const limit = clampLimit(args.limit, 10, 20);
        const url = prefixSearchUrl(site, { query, limit, namespace: '*' });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '标题候选');
        const rejected = apiErrorText(data, '标题候选');
        if (rejected !== '') return { text: `${rejected}\n请求：${url}` };
        const mapped = mapPrefixSearch(data);
        const labels = (await siteMeta.get(site, { signal: exec.signal }))?.labels;

        if (mapped.items.length === 0) {
          const fallbackUrl = allPagesUrl(site, { prefix: query, limit, namespace: 0 });
          const fallback = unwrap(
            await reader.read(fallbackUrl, { signal: exec.signal, fresh: args.fresh === true }),
            '标题候选（allpages 兜底）',
          );
          const listed = mapAllPages(fallback).items;
          if (listed.length === 0) return { text: `没有以「${query}」开头的页面标题。` };
          return {
            text: `${header([`标题候选「${query}」（allpages 前缀枚举，${listed.length} 条）`])}`
              + listed.map((item, index) => `${index + 1}. ${item.title}\n   ${pageUrl(site, item.title)}`).join('\n'),
          };
        }

        return {
          text: `${header([`标题候选「${query}」（${mapped.items.length} 条）`])}`
            + mapped.items.map((item, index) => `${index + 1}. ${titleWithNs(item.title, item.ns, labels)}`
              + `${item.pageid === undefined ? '' : `（pageid ${item.pageid}）`}`
              + `\n   ${pageUrl(site, item.title)}`).join('\n'),
        };
      },
    }),
  );

  return ['prts_status', 'prts_search', 'prts_titles'];
}
