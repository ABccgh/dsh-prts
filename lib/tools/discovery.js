/**
 * 发现类工具：站点自检（`prts_status`）、全文检索（`prts_search`）、标题候选（`prts_titles`）。
 *
 * 关于检索：PRTS 用的是 **MediaWiki 内置搜索后端**（实测没有 CirrusSearch），所以
 * `intitle:` / `incategory:` / `insource:` 这类 CirrusSearch 语法**不可用**
 * （实测 `intitle:阿米娅` 返回 0 命中，而普通 `阿米娅` 返回 28），
 * 而且片段是 **wikitext 原文**形态（`|名称=… |用途=…`）——工具描述里如实写明，片段做最小归约。
 *
 * 关于命名空间：接口的 `srnamespace` 只认数字。名字（`模板`）必须先经 siteinfo 解析成
 * `10`，否则 MediaWiki 只在 `warnings` 里说一句就**按全部命名空间搜**（真站实测：
 * `srnamespace=模板` 返回 828 条、`srnamespace=10` 返回 85 条）。解析在
 * `shared.js` 的 `resolveNamespace`，警告用 `apiWarningText` 如实打出来。
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
  TEXT_OUTPUT, TOOL_TIMEOUT_MS, abortError, alwaysSafe, apiErrorText, apiWarningText, clampInt, clampLimit,
  formatAge, header, listTail, requireText, resolveNamespace, titleWithNs, unwrap,
} from './shared.js';

/**
 * 注册 3 个发现类工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {Record<string, any>} config - 生效配置。
 * @param {{ site: object, reader: { read: Function, stats: Function }, siteMeta: { get: Function } }} deps - 依赖。
 * @returns {string[]} 已注册的工具名。
 */
export function registerDiscoveryTools(ctx, config, deps) {
  const { site, reader, siteMeta } = deps;

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
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const url = siteInfoUrl(site);
        const result = await reader.read(url, { signal: exec.signal, fresh: args.fresh === true });
        if (result?.aborted === true) throw abortError();
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

        const warnings = apiWarningText(result.data, '读取站点信息');
        const rejected = apiErrorText(result.data, '读取站点信息');
        if (rejected !== '') {
          return { text: [warnings, rejected, `接口：${url}`, ...configLines].filter((line) => line !== '').join('\n') };
        }

        const info = mapSiteInfo(result.data);
        const s = info.statistics ?? {};
        const number = (value) => (typeof value === 'number' ? String(value) : '-');
        return {
          text: [
            ...(warnings === '' ? [] : [warnings]),
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
        + 'namespace 可写命名空间名字（如 模板、分类、Category）或数字 id（自动经 siteinfo 解析）。'
        + '返回标题、pageid、字节数、最后编辑与命中片段（片段是 wikitext 原文，已做最小归约）。'
        + '要读正文请用 prts_page（长页面先 prts_sections）。只读。',
      parameters: {
        query: { type: 'string', required: true, description: '检索关键词，例如 "能天使 信物"；不支持 CirrusSearch 语法。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 10，上限 ${config.maxListedItems}。` },
        namespace: {
          type: 'string',
          description: '命名空间名字或数字 id，默认 0（主条目）；传 * 表示全部。名字会先经 siteinfo 解析。',
        },
        offset: { type: 'integer', description: '从第几条开始（翻页用），默认 0。' },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存（含站点信息缓存）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const query = requireText(args.query, 'query');
        const limit = clampLimit(args.limit, 10, config.maxListedItems);
        const offset = Math.max(0, clampInt(args.offset, 0));
        const fresh = args.fresh === true;
        const meta = await siteMeta.get(site, { signal: exec.signal, fresh });
        const { ns, label } = resolveNamespace(meta, args.namespace, 0);
        const url = searchUrl(site, { query, limit, offset, namespace: ns });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh }), '检索');
        const warnings = apiWarningText(data, '检索');
        const rejected = apiErrorText(data, '检索');
        if (rejected !== '') {
          return { text: [warnings, rejected, `请求：${url}`].filter((line) => line !== '').join('\n') };
        }
        const mapped = mapSearch(data);

        if (mapped.items.length === 0) {
          if (offset > 0) {
            const totalText = mapped.totalHits === null ? '未知' : String(mapped.totalHits);
            return {
              text: [
                warnings,
                `offset 超出命中范围（共 ${totalText} 条）：检索「${query}」从第 ${offset} 条开始没有结果（命名空间 ${label}）。`,
                '把 offset 改小或省略；命中总量以本行括号里的数字为准。',
                `请求：${url}`,
              ].filter((line) => line !== '').join('\n'),
            };
          }
          return {
            text: [
              warnings,
              `检索「${query}」没有命中（命名空间 ${label}）。`,
              '可试：换更短的关键词、把 namespace 传 * 搜全部命名空间、用命名空间名字（如 模板）确认参数生效，'
              + '或用 prts_titles 按前缀找标题；本站没有 CirrusSearch，intitle:/incategory:/insource: 这类语法不起作用。',
              `请求：${url}`,
            ].filter((line) => line !== '').join('\n'),
          };
        }

        const labels = meta?.labels;
        const lines = mapped.items.map((item, index) => {
          const metaParts = [
            item.pageid === undefined ? '' : `pageid ${item.pageid}`,
            item.size === undefined ? '' : `${item.size} 字节`,
            item.timestamp === undefined ? '' : formatAge(item.timestamp),
          ].filter((part) => part !== '').join('，');
          const snippet = cleanSnippet(item.snippet);
          return `${offset + index + 1}. ${titleWithNs(item.title, item.ns, labels)}${metaParts === '' ? '' : `（${metaParts}）`}`
            + `${snippet === '' ? '' : `\n   ${snippet}`}`;
        });
        const nextOffset = mapped.offset ?? offset + mapped.items.length;
        return {
          text: `${warnings === '' ? '' : `${warnings}\n`}`
            + `检索「${query}」：${mapped.totalHits === null ? '' : `共 ${mapped.totalHits} 条命中，`}`
            + `本次 ${mapped.items.length} 条（命名空间 ${label}）\n`
            + lines.join('\n')
            + listTail(mapped.items.length, null, '条', mapped.hasMore ? `还有更多，下一页用 offset=${nextOffset}` : ''),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'prts_titles',
      description:
        '按前缀猜页面标题，把名字对准后再交给 prts_page。返回标题、命名空间与规范 URL'
        + '（先试 prefixsearch，空结果回退 allpages 前缀枚举）。有更多候选时给出 offset 续取。只读。',
      parameters: {
        query: { type: 'string', required: true, description: '标题前缀，例如 "阿米娅" 或 "龙门"。' },
        limit: { type: 'integer', description: '最多返回多少条，默认 10，上限 20。' },
        offset: { type: 'integer', description: '从第几条开始（prefixsearch 翻页用），默认 0。' },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const query = requireText(args.query, 'query');
        const limit = clampLimit(args.limit, 10, 20);
        const offset = Math.max(0, clampInt(args.offset, 0));
        const fresh = args.fresh === true;
        const meta = await siteMeta.get(site, { signal: exec.signal, fresh });
        const url = prefixSearchUrl(site, { query, limit, namespace: '*', offset });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh }), '标题候选');
        const warnings = apiWarningText(data, '标题候选');
        const rejected = apiErrorText(data, '标题候选');
        if (rejected !== '') {
          return { text: [warnings, rejected, `请求：${url}`].filter((line) => line !== '').join('\n') };
        }
        const mapped = mapPrefixSearch(data);
        const labels = meta?.labels;

        if (mapped.items.length === 0 && offset === 0) {
          const fallbackUrl = allPagesUrl(site, { prefix: query, limit, namespace: 0 });
          const fallback = unwrap(await reader.read(fallbackUrl, { signal: exec.signal, fresh }), '标题候选（allpages 兜底）');
          const fallbackWarnings = apiWarningText(fallback, '标题候选（allpages 兜底）');
          const listed = mapAllPages(fallback);
          const warningLines = [warnings, fallbackWarnings].filter((line) => line !== '');
          if (listed.items.length === 0) {
            return { text: [...warningLines, `没有以「${query}」开头的页面标题。`].join('\n') };
          }
          const more = listed.hasMore
            ? `\n\n还有更多（前缀枚举不支持 offset，用更具体的前缀缩小范围）`
            : '';
          return {
            text: [
              ...warningLines,
              header([`标题候选「${query}」（allpages 前缀枚举，本次 ${listed.items.length} 条）`])
              + listed.items.map((item, index) => `${index + 1}. ${item.title}\n   ${pageUrl(site, item.title)}`).join('\n')
              + more,
            ].join('\n'),
          };
        }
        if (mapped.items.length === 0) {
          return {
            text: [
              warnings,
              `offset=${offset} 超出「${query}」的前缀候选范围（本次 0 条）。把 offset 改小或省略。`,
              `请求：${url}`,
            ].filter((line) => line !== '').join('\n'),
          };
        }

        const nextOffset = mapped.offset ?? offset + mapped.items.length;
        const more = mapped.hasMore ? `\n\n还有更多（用 offset=${nextOffset} 继续）` : '';
        return {
          text: `${warnings === '' ? '' : `${warnings}\n`}`
            + header([`标题候选「${query}」（本次 ${mapped.items.length} 条）`])
            + mapped.items.map((item, index) => `${index + 1}. ${titleWithNs(item.title, item.ns, labels)}`
              + `${item.pageid === undefined ? '' : `（pageid ${item.pageid}）`}`
              + `\n   ${pageUrl(site, item.title)}`).join('\n')
            + more,
        };
      },
    }),
  );

  return ['prts_status', 'prts_search', 'prts_titles'];
}
