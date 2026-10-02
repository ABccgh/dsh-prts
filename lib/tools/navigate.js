/**
 * 导航类工具：页面关系（`prts_links`）、分类成员（`prts_category`）、
 * 最近改动（`prts_recent_changes`）。
 *
 * 用途偏「顺藤摸瓜」：检索只能给命中，链接/反链与分类才能把相关页面串起来
 * （例如从「干员」分类看全集，或从模板看被哪些页面引用）。
 *
 * 两条约定：
 * - **标题原样打印**：接口返回的标题本来就带本地化命名空间前缀（`分类:干员`、`模板:关卡报酬/doc`），
 *   再补一次会拼出废标题；
 * - **接口错误如实上报**：`{error:{code,info}}` 不能当成「没有成员 / 没有链接」。
 *
 * @module dsh-prts/tools/navigate
 */

import {
  backlinksUrl,
  categoryMembersUrl,
  linksUrl,
  mapBacklinks,
  mapCategoryMembers,
  mapLinks,
  mapRecentChanges,
  recentChangesUrl,
  stripCategoryPrefix,
} from '../mediawiki.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT, alwaysSafe, apiErrorText, clampLimit, formatAge, header, namespaceParam, requireText, titleWithNs, unwrap,
} from './shared.js';

/** 分类成员的类型过滤值。 */
const CATEGORY_TYPES = new Map([
  ['page', 'page'],
  ['subcat', 'subcat'],
  ['file', 'file'],
  ['all', undefined],
]);

/**
 * 注册 3 个导航类工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {Record<string, any>} config - 生效配置。
 * @param {{ site: object, reader: { read: Function }, siteMeta: { get: Function } }} deps - 依赖。
 * @returns {string[]} 已注册的工具名。
 */
export function registerNavigateTools(ctx, config, deps) {
  const { site, reader, siteMeta } = deps;
  const maxLinks = 100;
  const maxCategory = 200;
  const maxRecent = 100;

  ctx.tools.register(
    defineTool({
      name: 'prts_links',
      description:
        '列出 PRTS 页面的出链（direction="out"，页面里指向别的页面的链接）或反向链接（direction="in"，'
        + '哪些页面链接到了它）。用来从一页扩散到相关页，或查某个模板被哪些页面引用。只读。',
      parameters: {
        title: { type: 'string', required: true, description: '页面标题。' },
        direction: { type: 'string', enum: ['out', 'in'], description: 'out（默认，出链）或 in（反向链接）。' },
        namespace: { type: 'string', description: '只看某个命名空间的链接（id 或名字），默认不限。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 30，上限 ${maxLinks}。` },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const title = requireText(args.title, 'title');
        const limit = clampLimit(args.limit, 30, maxLinks);
        const direction = args.direction === 'in' ? 'in' : 'out';
        const namespace = args.namespace === undefined ? undefined : namespaceParam(args.namespace, '*');
        const nsFilter = namespace === '*' ? undefined : namespace;
        const labels = (await siteMeta.get(site, { signal: exec.signal }))?.labels;

        if (direction === 'in') {
          const url = backlinksUrl(site, { title, limit, namespace: nsFilter });
          const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '读取反向链接');
          const rejected = apiErrorText(data, '读取反向链接');
          if (rejected !== '') return { text: rejected };
          const items = mapBacklinks(data);
          if (items.length === 0) return { text: `没有页面链接到「${title}」（命名空间 ${nsFilter ?? '全部'}）。` };
          const more = data?.continue !== undefined;
          return {
            text: `${header([`# 链接到「${title}」的页面（共 ${items.length} 条${more ? '，还有更多' : ''}）`])}`
              + items.map((item, index) => `${index + 1}. ${titleWithNs(item.title, item.ns, labels)}${item.redirect ? '（经由重定向）' : ''}`).join('\n')
              + (more ? `\n\n（已达 limit=${limit}；提高 limit（上限 ${maxLinks}）或用 namespace 过滤继续缩小）` : ''),
          };
        }

        const url = linksUrl(site, { title, limit, namespace: nsFilter });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '读取出链');
        const rejected = apiErrorText(data, '读取出链');
        if (rejected !== '') return { text: rejected };
        const mapped = mapLinks(data, title);
        if (!mapped.found) return { text: `页面「${title}」不存在，出链无法读取（先用 prts_search 或 prts_titles 找标题）。` };
        if (mapped.links.length === 0) return { text: `「${mapped.title}」没有指向别处的链接（命名空间 ${nsFilter ?? '全部'}）。` };
        const more = data?.continue !== undefined;
        return {
          text: `${header([`# 「${mapped.title}」的出链（共 ${mapped.links.length} 条${more ? '，还有更多' : ''}）`])}`
            + mapped.links.map((link, index) => `${index + 1}. ${titleWithNs(link.title, link.ns, labels)}`).join('\n')
            + (more ? `\n\n（已达 limit=${limit}；提高 limit（上限 ${maxLinks}）或用 namespace 过滤）` : ''),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'prts_category',
      description:
        '列出某个分类的成员。分类名可写「干员」或「分类:干员」（该站命名空间是本地化中文名）。'
        + 'type 可选 page（默认）、subcat（子分类）、file（文件）、all。找「某类东西的全集」时最有用。只读。',
      parameters: {
        category: { type: 'string', required: true, description: '分类名，可带或不带 分类:/Category: 前缀，例如 干员。' },
        type: { type: 'string', enum: ['page', 'subcat', 'file', 'all'], description: '成员类型，默认 page。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 30，上限 ${maxCategory}。` },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const category = requireText(args.category, 'category');
        const limit = clampLimit(args.limit, 30, maxCategory);
        const rawType = String(args.type ?? 'page');
        const type = CATEGORY_TYPES.has(rawType) ? CATEGORY_TYPES.get(rawType) : 'page';
        const meta = await siteMeta.get(site, { signal: exec.signal });
        const name = stripCategoryPrefix(category, meta?.categoryNames);
        const url = categoryMembersUrl(site, { category, limit, type, aliases: meta?.categoryNames });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '读取分类');
        const rejected = apiErrorText(data, '读取分类');
        if (rejected !== '') return { text: rejected };
        const items = mapCategoryMembers(data);
        if (items.length === 0) {
          return {
            text: `分类「分类:${name}」没有成员（type=${rawType}）。`
              + '\n分类名区分大小写；也可以用 prts_search 试 incategory 之外的普通关键词。',
          };
        }
        const more = data?.continue !== undefined;
        return {
          text: `${header([`# 分类:${name} 的成员（type=${rawType}，共 ${items.length} 条${more ? '，还有更多' : ''}）`])}`
            + items.map((item, index) => `${index + 1}. ${titleWithNs(item.title, item.ns, meta?.labels)}`
              + `${item.timestamp === undefined ? '' : `（${formatAge(item.timestamp)}）`}`).join('\n')
            + (more ? `\n\n（已达 limit=${limit}；提高 limit（上限 ${maxCategory}）或用 type=subcat 先看子分类）` : ''),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'prts_recent_changes',
      description:
        '看 PRTS 最近改动（默认最近 7 天）：类型（新建/编辑）、页面、编辑者、字节变化与编辑摘要。'
        + '想知道某个干员/机制是不是刚改过、或跟着版本更新走时用它。只读。',
      parameters: {
        limit: { type: 'integer', description: `最多返回多少条，默认 20，上限 ${maxRecent}。` },
        days: { type: 'integer', description: '回溯多少天，默认 7，上限 90。' },
        namespace: { type: 'string', description: '限定命名空间（id 或名字），默认全部。' },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const limit = clampLimit(args.limit, 20, maxRecent);
        const days = clampLimit(args.days, 7, 90);
        const namespace = args.namespace === undefined ? undefined : namespaceParam(args.namespace, '*');
        const url = recentChangesUrl(site, {
          limit,
          days,
          namespace: namespace === '*' ? undefined : namespace,
        });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '读取最近改动');
        const rejected = apiErrorText(data, '读取最近改动');
        if (rejected !== '') return { text: rejected };
        const items = mapRecentChanges(data);
        const labels = (await siteMeta.get(site, { signal: exec.signal }))?.labels;
        if (items.length === 0) return { text: `最近 ${days} 天内没有符合条件的改动（命名空间 ${namespace ?? '全部'}）。` };
        const lines = items.map((item) => {
          const delta = item.oldlen !== undefined && item.newlen !== undefined
            ? `（${item.oldlen}→${item.newlen}，${item.newlen - item.oldlen >= 0 ? '+' : ''}${item.newlen - item.oldlen}）`
            : '';
          const kind = item.type === 'new' ? '新建' : '编辑';
          const comment = item.comment === '' ? '' : `  ${item.comment}`;
          return `${item.timestamp}（${formatAge(item.timestamp)}）${kind} ${titleWithNs(item.title, item.ns, labels)} — ${item.user}${delta}${comment}`;
        });
        return {
          text: `${header([
            `# PRTS 最近 ${days} 天的改动（共 ${items.length} 条，命名空间 ${namespace ?? '全部'}）`,
            '时间戳是 ISO 8601（UTC）；站点时区为 Asia/Shanghai（+8）。',
          ])}${lines.join('\n')}`,
        };
      },
    }),
  );

  return ['prts_category', 'prts_links', 'prts_recent_changes'];
}
