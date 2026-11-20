/**
 * 导航类工具：页面关系（`prts_links`）、分类成员（`prts_category`）、
 * 最近改动（`prts_recent_changes`）。
 *
 * 用途偏「顺藤摸瓜」：检索只能给命中，链接/反链与分类才能把相关页面串起来
 * （例如从「干员」分类看全集，或从模板看被哪些页面引用）。
 *
 * 几条约定：
 * - **标题原样打印**：接口返回的标题本来就带本地化命名空间前缀（`分类:干员`、`模板:关卡报酬/doc`），
 *   再补一次会拼出废标题；
 * - **接口错误如实上报**：`{error:{code,info}}` 不能当成「没有成员 / 没有链接」；
 * - **先探测存在性再解释空结果**：`list=backlinks` 对不存在的标题只会返回空列表（不报错），
 *   所以空结果要先用 `prop=info` 分辨「页面不存在」和「确实没有」；
 * - **`in` 方向要查两组**：`list=backlinks` 是「正文里链接到它」，`list=embeddedin` 是
 *   「嵌入/引用了它」；模板的真实使用者（`{{模板}}`）只出现在后者，只查反链会答不出
 *   「这个模板被哪些页面引用」；
 * - **分页用接口自己的 token**：每个列表的 `<前缀>continue` 各自独立，原样回传即可。
 *
 * @module dsh-prts/tools/navigate
 */

import {
  backlinksUrl,
  categoryMembersUrl,
  categoryTitle,
  embeddedInUrl,
  linksUrl,
  mapBacklinks,
  mapCategoryMembers,
  mapEmbeddedIn,
  mapLinks,
  mapPageExistence,
  mapRecentChanges,
  namespaceLabel,
  pageExistenceUrl,
  recentChangesUrl,
  stripCategoryPrefix,
} from '../mediawiki.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT, TOOL_TIMEOUT_MS, alwaysSafe, apiErrorText, apiWarningText, clampLimit, continueTokenText,
  formatAge, header, listTail, parseContinueToken, requireText, resolveNamespace, titleWithNs, unwrap,
} from './shared.js';

/** 分类成员的类型过滤值。 */
const CATEGORY_TYPES = new Map([
  ['page', 'page'],
  ['subcat', 'subcat'],
  ['file', 'file'],
  ['all', undefined],
]);

/** `in` 方向两个列表的续取参数（合并成一个 token 回显）。 */
const IN_CONTINUE_KEYS = ['blcontinue', 'eicontinue', 'continue'];

/**
 * 注册 3 个导航类工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {Record<string, any>} config - 生效配置。
 * @param {{ site: object, reader: { read: Function }, siteMeta: { get: Function } }} deps - 依赖。
 * @returns {string[]} 已注册的工具名。
 */
export function registerNavigateTools(ctx, config, deps) {
  const { site, reader, siteMeta } = deps;
  const maxListed = config.maxListedItems;

  /**
   * 存在性探测（`prop=info`）：空结果到底是「不存在」还是「没有」。
   * @param {string} title - 页面标题。
   * @param {{ signal?: AbortSignal, fresh?: boolean }} options - 选项。
   * @returns {Promise<{ info?: object, error?: string }>} 结果。
   */
  async function probeExistence(title, options) {
    const url = pageExistenceUrl(site, { title });
    const data = unwrap(await reader.read(url, { signal: options.signal, fresh: options.fresh === true }), '页面存在性探测');
    const rejected = apiErrorText(data, '页面存在性探测');
    if (rejected !== '') return { error: rejected };
    return { info: mapPageExistence(data) };
  }

  ctx.tools.register(
    defineTool({
      name: 'prts_links',
      description:
        '列出 PRTS 页面的出链（direction="out"，页面里指向别的页面的链接）或反向链接'
        + '（direction="in"：同时查「链接到它的页面」list=backlinks 与「嵌入它的页面」list=embeddedin，'
        + '模板被哪些页面引用看第二组）。namespace 可写名字或 id。用 continue 翻页。只读。',
      parameters: {
        title: { type: 'string', required: true, description: '页面标题，例如 "阿米娅" 或 "模板:干员"。' },
        direction: { type: 'string', enum: ['out', 'in'], description: 'out（默认，出链）或 in（反向链接 + 模板嵌入）。' },
        namespace: { type: 'string', description: '只看某个命名空间的链接（名字或 id），默认不限。' },
        limit: { type: 'integer', description: `每页最多返回多少条，默认 30，上限 ${maxListed}。` },
        continue: { type: 'string', description: '翻页：原样回传上次输出里的 continue 值。' },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存（含站点信息缓存）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const title = requireText(args.title, 'title');
        const limit = clampLimit(args.limit, 30, maxListed);
        const direction = args.direction === 'in' ? 'in' : 'out';
        const fresh = args.fresh === true;
        const meta = await siteMeta.get(site, { signal: exec.signal, fresh });
        const namespace = args.namespace === undefined || args.namespace === null || String(args.namespace).trim() === ''
          ? { ns: '*', label: '全部' }
          : resolveNamespace(meta, args.namespace, '*');
        const nsFilter = namespace.ns === '*' ? undefined : namespace.ns;

        const probe = await probeExistence(title, { signal: exec.signal, fresh });
        if (probe.error !== undefined) return { text: probe.error };
        if (probe.info?.found !== true) {
          return {
            text: `页面「${title}」不存在，无法读取${direction === 'in' ? '反向链接' : '出链'}。`
              + '先用 prts_search 检索或 prts_titles 对准标题；模板也要带命名空间前缀（如 模板:干员）。',
          };
        }
        const resolvedTitle = probe.info.title === '' ? title : probe.info.title;
        const labels = meta?.labels;

        if (direction === 'in') {
          const continuation = parseContinueToken(args.continue, IN_CONTINUE_KEYS);
          const backUrl = backlinksUrl(site, { title: resolvedTitle, limit, namespace: nsFilter, continuation });
          const embedUrl = embeddedInUrl(site, { title: resolvedTitle, limit, namespace: nsFilter, continuation });
          // 两个列表能并发取，但用 allSettled：两边同时失败时不会留下未处理的 rejection。
          const [backResult, embedResult] = await Promise.allSettled([
            reader.read(backUrl, { signal: exec.signal, fresh }),
            reader.read(embedUrl, { signal: exec.signal, fresh }),
          ]);
          if (backResult.status === 'rejected') throw backResult.reason;
          if (embedResult.status === 'rejected') throw embedResult.reason;
          const backData = unwrap(backResult.value, '读取反向链接');
          const embedData = unwrap(embedResult.value, '读取模板嵌入');
          const rejected = [
            apiErrorText(backData, '读取反向链接'),
            apiErrorText(embedData, '读取模板嵌入'),
          ].filter((line) => line !== '').join('\n');
          if (rejected !== '') return { text: rejected };
          const warningLines = [
            apiWarningText(backData, '读取反向链接'),
            apiWarningText(embedData, '读取模板嵌入'),
          ].filter((line) => line !== '');
          const backlinks = mapBacklinks(backData);
          const embedded = mapEmbeddedIn(embedData);
          const backToken = continueTokenText(backData, 'backlinks');
          const embedToken = continueTokenText(embedData, 'embeddedin');
          const mergedToken = continueTokenText([backData, embedData], IN_CONTINUE_KEYS);
          const renderGroup = (heading, items, renderItem, token, noneText) => {
            const lines = items.map((item, index) => `${index + 1}. ${renderItem(item)}`);
            return `${heading}${lines.length === 0 ? `\n${noneText}` : `\n${lines.join('\n')}`}`
              + `${token === '' ? '' : `\n\n本组还有更多：continue=${token}`}`;
          };
          return {
            text: [
              ...warningLines,
              header([`# 链接到「${resolvedTitle}」的页面（direction=in，命名空间 ${namespace.label}）`]).trimEnd(),
              '',
              renderGroup(
                `## 页面链接（list=backlinks，本次 ${backlinks.length} 条）`,
                backlinks,
                (item) => `${titleWithNs(item.title, item.ns, labels)}${item.redirect ? '（经由重定向）' : ''}`,
                backToken,
                '没有页面在正文里链接到它。',
              ),
              '',
              renderGroup(
                `## 模板嵌入（list=embeddedin，本次 ${embedded.length} 条）`,
                embedded,
                (item) => titleWithNs(item.title, item.ns, labels),
                embedToken,
                '没有页面嵌入（引用）它。',
              ),
              listTail(
                backlinks.length + embedded.length,
                null,
                '个页面',
                mergedToken === '' ? '' : `还有更多，继续取下一页：continue=${mergedToken}`,
              ),
            ].join('\n'),
          };
        }

        const continuation = parseContinueToken(args.continue, 'links');
        const url = linksUrl(site, { title: resolvedTitle, limit, namespace: nsFilter, continuation });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh }), '读取出链');
        const warnings = apiWarningText(data, '读取出链');
        const rejected = apiErrorText(data, '读取出链');
        if (rejected !== '') return { text: [warnings, rejected].filter((line) => line !== '').join('\n') };
        const mapped = mapLinks(data, resolvedTitle);
        if (!mapped.found) {
          return { text: `页面「${resolvedTitle}」不存在，出链无法读取（先用 prts_search 或 prts_titles 找标题）。` };
        }
        const token = continueTokenText(data, 'links');
        if (mapped.links.length === 0) {
          return {
            text: `${warnings === '' ? '' : `${warnings}\n`}`
              + `「${mapped.title}」没有指向别处的链接（命名空间 ${namespace.label}）。`,
          };
        }
        return {
          text: `${warnings === '' ? '' : `${warnings}\n`}`
            + header([`# 「${mapped.title}」的出链（direction=out，命名空间 ${namespace.label}，本次 ${mapped.links.length} 条）`])
            + mapped.links.map((link, index) => `${index + 1}. ${titleWithNs(link.title, link.ns, labels)}`).join('\n')
            + listTail(
              mapped.links.length,
              null,
              '个页面',
              token === '' ? '' : `还有更多，继续取下一页：continue=${token}`,
            ),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'prts_category',
      description:
        '列出某个分类的成员。分类名可写「干员」或「分类:干员」（该站命名空间是本地化中文名）。'
        + 'type 可选 page（默认）、subcat（子分类）、file（文件）、all。'
        + '空结果会先探测分类页是否存在，区分「分类不存在」与「分类没有成员」。'
        + '找「某类东西的全集」时最有用；用 continue 翻页。只读。',
      parameters: {
        category: { type: 'string', required: true, description: '分类名，可带或不带 分类:/Category: 前缀，例如 干员。' },
        type: { type: 'string', enum: ['page', 'subcat', 'file', 'all'], description: '成员类型，默认 page。' },
        limit: { type: 'integer', description: `每页最多返回多少条，默认 30，上限 ${maxListed}。` },
        continue: { type: 'string', description: '翻页：原样回传上次输出里的 continue 值。' },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存（含站点信息缓存）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const category = requireText(args.category, 'category');
        const limit = clampLimit(args.limit, 30, maxListed);
        const rawType = String(args.type ?? 'page');
        const type = CATEGORY_TYPES.has(rawType) ? CATEGORY_TYPES.get(rawType) : 'page';
        const fresh = args.fresh === true;
        const meta = await siteMeta.get(site, { signal: exec.signal, fresh });
        const name = stripCategoryPrefix(category, meta?.categoryNames);
        const target = categoryTitle(name, meta?.categoryNames);
        // 展示用本地化前缀（该站 14 号命名空间叫「分类」），接口参数用 Category:。
        const categoryLabel = namespaceLabel(14, meta?.labels) || 'Category';
        const display = `${categoryLabel}:${name}`;
        const probe = await probeExistence(target, { signal: exec.signal, fresh });
        if (probe.error !== undefined) return { text: probe.error };

        const continuation = parseContinueToken(args.continue, 'categorymembers');
        const url = categoryMembersUrl(site, { category, limit, type, aliases: meta?.categoryNames, continuation });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh }), '读取分类');
        const warnings = apiWarningText(data, '读取分类');
        const rejected = apiErrorText(data, '读取分类');
        if (rejected !== '') return { text: [warnings, rejected].filter((line) => line !== '').join('\n') };
        const items = mapCategoryMembers(data);
        const token = continueTokenText(data, 'categorymembers');

        if (items.length === 0) {
          if (probe.info?.found !== true) {
            return {
              text: [
                warnings,
                `分类「${display}」不存在（分类页还没有创建）。`,
                '分类名区分大小写，且要写对命名空间：本站分类是「分类:」，英文写法 Category: 也认。',
                '可用 prts_search 或 prts_titles 找准确的分类名；分类页不存在时也可能有页面标注了这个分类，'
                + '所以别把它当成「该分类一定为空」。',
              ].filter((line) => line !== '').join('\n'),
            };
          }
          return {
            text: [
              warnings,
              `分类「${display}」没有成员（type=${rawType}）。`,
              '分类页存在但当前没有成员；试 type=all，或用 prts_search 的普通关键词替代。',
            ].filter((line) => line !== '').join('\n'),
          };
        }

        const missingNote = probe.info?.found === true ? '' : '\n（注意：该分类页尚未创建，但已有页面标注了这个分类）';
        return {
          text: `${warnings === '' ? '' : `${warnings}\n`}`
            + header([`# ${display} 的成员（type=${rawType}，本次 ${items.length} 条）`])
            + items.map((item, index) => `${index + 1}. ${titleWithNs(item.title, item.ns, meta?.labels)}`
              + `${item.timestamp === undefined ? '' : `（${formatAge(item.timestamp)}）`}`).join('\n')
            + missingNote
            + listTail(
              items.length,
              null,
              '个成员',
              token === '' ? '' : `还有更多，继续取下一页：continue=${token}`,
            ),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'prts_recent_changes',
      description:
        '看 PRTS 最近改动（默认最近 7 天）：类型（新建/编辑）、页面、编辑者、字节变化与编辑摘要。'
        + 'namespace 可写名字或 id；用 continue 翻页。'
        + '想知道某个干员/机制是不是刚改过、或跟着版本更新走时用它。只读。',
      parameters: {
        limit: { type: 'integer', description: `每页最多返回多少条，默认 20，上限 ${maxListed}。` },
        days: { type: 'integer', description: '回溯多少天，默认 7，上限 90。' },
        namespace: { type: 'string', description: '限定命名空间（名字或 id），默认全部。' },
        continue: { type: 'string', description: '翻页：原样回传上次输出里的 continue 值。' },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存（含站点信息缓存）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const limit = clampLimit(args.limit, 20, maxListed);
        const days = clampLimit(args.days, 7, 90);
        const fresh = args.fresh === true;
        const meta = await siteMeta.get(site, { signal: exec.signal, fresh });
        const namespace = args.namespace === undefined || args.namespace === null || String(args.namespace).trim() === ''
          ? { ns: '*', label: '全部' }
          : resolveNamespace(meta, args.namespace, '*');
        const continuation = parseContinueToken(args.continue, 'recentchanges');
        const url = recentChangesUrl(site, {
          limit,
          days,
          namespace: namespace.ns === '*' ? undefined : namespace.ns,
          continuation,
        });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh }), '读取最近改动');
        const warnings = apiWarningText(data, '读取最近改动');
        const rejected = apiErrorText(data, '读取最近改动');
        if (rejected !== '') return { text: [warnings, rejected].filter((line) => line !== '').join('\n') };
        const items = mapRecentChanges(data);
        const token = continueTokenText(data, 'recentchanges');
        if (items.length === 0) {
          return {
            text: `${warnings === '' ? '' : `${warnings}\n`}`
              + `最近 ${days} 天内没有符合条件的改动（命名空间 ${namespace.label}）。`,
          };
        }
        const labels = meta?.labels;
        const lines = items.map((item) => {
          const delta = item.oldlen !== undefined && item.newlen !== undefined
            ? `（${item.oldlen}→${item.newlen}，${item.newlen - item.oldlen >= 0 ? '+' : ''}${item.newlen - item.oldlen}）`
            : '';
          const kind = item.type === 'new' ? '新建' : '编辑';
          const comment = item.comment === '' ? '' : `  ${item.comment}`;
          return `${item.timestamp}（${formatAge(item.timestamp)}）${kind} ${titleWithNs(item.title, item.ns, labels)} — ${item.user}${delta}${comment}`;
        });
        return {
          text: `${warnings === '' ? '' : `${warnings}\n`}`
            + `${header([
              `# PRTS 最近 ${days} 天的改动（本次 ${items.length} 条，命名空间 ${namespace.label}）`,
              '时间戳是 ISO 8601（UTC）；站点时区为 Asia/Shanghai（+8）。',
            ])}${lines.join('\n')}`
            + listTail(
              items.length,
              null,
              '条改动',
              token === '' ? '' : `还有更多，继续取下一页：continue=${token}`,
            ),
        };
      },
    }),
  );

  return ['prts_category', 'prts_links', 'prts_recent_changes'];
}
