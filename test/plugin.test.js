/**
 * 插件级离线测试：工具注册、配置归一、每个工具的真实输出（含错误分支、缓存与节流重试）。
 *
 * 出网用假 fetch 注入（`apply(ctx, config, { fetchImpl })`），路由按查询参数分发，
 * 断言打的是「模型实际读到的文案」。
 *
 * @module dsh-prts/test/plugin
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as plugin from '../lib/index.js';
import { apply, name, normalizeConfig } from '../lib/index.js';
import {
  ALL_PAGES, ALL_PAGES_EMPTY, API_ERROR_BADVALUE, API_ERROR_MISSINGTITLE, API_ERROR_NOSUCHSECTION,
  API_ERROR_PARAM, BACKLINKS, BACKLINKS_EMPTY, CATEGORY_MEMBERS, CATEGORY_MEMBERS_EMPTY, EMBEDDEDIN,
  EMBEDDEDIN_EMPTY, LINKS, PAGE_INFO, PAGE_INFO_MISSING, PAGE_EXISTS_AMIYA, PAGE_TEXT, PAGE_TEXT_FLAT,
  PREFIX_SEARCH, PREFIX_SEARCH_EMPTY, RECENT_CHANGES, SEARCH, SEARCH_EMPTY, SEARCH_OFFSET_PAST,
  SEARCH_WITH_WARNING, SITEINFO, THROTTLE_HTML, WIKITEXT,
} from './fixtures/fixtures.js';
import { TOOL_TIMEOUT_MS } from '../lib/tools/shared.js';

const EXPECTED_TOOLS = [
  'prts_status', 'prts_search', 'prts_titles',
  'prts_page', 'prts_sections', 'prts_page_info',
  'prts_links', 'prts_category', 'prts_recent_changes',
  'prts_operator',
];

/** JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** 拦截页响应（567 或 200 + HTML 空壳）。 */
function htmlResponse(status = 567) {
  return new Response(THROTTLE_HTML, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

/** undici 风格的三层嵌套网络错误。 */
function networkError(code) {
  const error = new Error('fetch failed');
  error.cause = Object.assign(new Error(`connect ${code}`), { code });
  return error;
}

/** 按 URL 决定返回哪个 fixture（顺序有意义：wikitext 必须排在 text 之前）。 */
function routeFor(rawUrl) {
  const params = new URL(rawUrl).searchParams;
  if (params.get('meta') === 'siteinfo') return 'SITEINFO';
  if (params.get('prop') === 'info') return 'PAGEEXISTS';
  if (params.get('list') === 'search') return 'SEARCH';
  if (params.get('list') === 'prefixsearch') return 'PREFIXSEARCH';
  if (params.get('list') === 'allpages') return 'ALLPAGES';
  if (params.get('list') === 'backlinks') return 'BACKLINKS';
  if (params.get('list') === 'embeddedin') return 'EMBEDDEDIN';
  if (params.get('list') === 'categorymembers') return 'CATEGORYMEMBERS';
  if (params.get('list') === 'recentchanges') return 'RECENTCHANGES';
  if (String(params.get('prop')).includes('wikitext')) return 'WIKITEXT';
  if (String(params.get('prop')).includes('pageprops')) return 'PAGEINFO';
  if (params.get('prop') === 'links') return 'LINKS';
  if (params.get('action') === 'parse') return 'PAGETEXT';
  return 'SITEINFO';
}

const FIXTURES = {
  SITEINFO,
  SEARCH,
  PREFIXSEARCH: PREFIX_SEARCH,
  ALLPAGES: ALL_PAGES,
  BACKLINKS,
  EMBEDDEDIN,
  CATEGORYMEMBERS: CATEGORY_MEMBERS,
  RECENTCHANGES: RECENT_CHANGES,
  WIKITEXT,
  PAGEINFO: PAGE_INFO,
  PAGEEXISTS: PAGE_EXISTS_AMIYA,
  LINKS,
  PAGETEXT: PAGE_TEXT,
};

/** 造一个最小上下文，并记录 warn 日志。 */
function makeCtx() {
  const tools = new Map();
  const warnings = [];
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`重复注册工具 ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get() {
      return undefined;
    },
    logger: { info() {}, warn(message) { warnings.push(String(message)); } },
  };
  return { ctx, tools, warnings };
}

/**
 * 装配插件。
 * @param {Record<string, any>} [config] - 覆盖配置。
 * @param {Record<string, Function|Response|Error>} [overrides] - 按路由名覆盖返回。
 * @returns {Promise<{ tools: Map<string, any>, calls: string[], warnings: string[], returned: unknown }>} 结果。
 */
async function boot(config = {}, overrides = {}) {
  const { ctx, tools, warnings } = makeCtx();
  const calls = [];
  const fetchImpl = async (rawUrl) => {
    const url = String(rawUrl);
    calls.push(url);
    const route = routeFor(url);
    const override = overrides[route];
    if (override !== undefined) {
      const value = typeof override === 'function' ? override(url) : override;
      if (value instanceof Response) return value.clone();
      if (value instanceof Error) throw value;
      return value;
    }
    return jsonResponse(FIXTURES[route] ?? SITEINFO);
  };
  const returned = await apply(ctx, { throttleBaseDelayMs: 0, ...config }, { fetchImpl });
  return { tools, calls, warnings, returned };
}

/** 调用一个已注册的工具。 */
function call(tools, toolName, args = {}) {
  const definition = tools.get(toolName);
  assert.ok(definition, `工具 ${toolName} 没有注册`);
  return definition.execute(args, { signal: AbortSignal.timeout(10_000) });
}

test('模块契约：导出 name / inject / apply / normalizeConfig，且不导出 Config', () => {
  assert.equal(name, 'prts');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof apply, 'function');
  assert.equal(typeof normalizeConfig, 'function');
  assert.equal('Config' in plugin, false, '没有 Config 时 cordis 会原样透传配置对象');
});

test('注册 10 个工具，且每个定义完整、参数里没有多余的多站点参数', async () => {
  const { tools, returned } = await boot();
  assert.deepEqual([...tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
  for (const [toolName, definition] of tools) {
    assert.equal(definition.name, toolName);
    assert.ok(definition.description.length > 20, `${toolName} 的 description 太短`);
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.isConcurrencySafe(), true);
    assert.equal(definition.timeoutMs, TOOL_TIMEOUT_MS, `${toolName} 应带 90 秒兜底超时`);
    assert.equal(Object.hasOwn(definition.parameters.properties, 'wiki'), false, `${toolName} 不该有 wiki 参数`);
  }
  assert.equal(returned, undefined, 'apply 不能返回值（Cordis 会把返回值当 effect）');
});

test('normalizeConfig：PRTS 的默认值', () => {
  const config = normalizeConfig({});
  assert.equal(config.wikiBaseUrl, 'https://prts.wiki');
  assert.equal(config.apiPath, '/api.php');
  assert.equal(config.articlePath, '/w/$1');
  assert.equal(config.maxChars, 20_000);
  assert.equal(config.maxListedItems, 50);
  assert.equal(config.cacheTtlMs, 300_000);
  assert.equal(config.cacheMaxEntries, 24);
  assert.equal(config.throttleAttempts, 3);
  assert.equal(config.keepImages, false);
  assert.equal(config.webFallback, true);
  assert.deepEqual(config.dropClassPrefixes, [], 'PRTS 不该按前缀丢 class');
  assert.deepEqual(config.configWarnings, []);
  assert.ok(config.userAgent.includes('dsh-prts'));
  assert.ok(config.dropClasses.includes('navbox'));
  assert.ok(config.dropClasses.includes('mdi'));
  assert.equal(config.dropClasses.some((c) => c.startsWith('smw')), false, 'SMW 是数据，不能进黑名单');
});

test('normalizeConfig：写错的字段回退默认值，每个被拒字段各留一条告警', () => {
  const config = normalizeConfig({
    wikiBaseUrl: 'not-a-url',
    apiPath: 'api.php',
    articlePath: '/wiki',
    maxChars: -5,
    trustSystemCa: 'x',
  });
  assert.equal(config.wikiBaseUrl, 'https://prts.wiki');
  assert.equal(config.apiPath, '/api.php', 'api.php 是合法写法（自动补 /）');
  assert.equal(config.articlePath, '/$1', '缺 $1 的写法退回按 baseUrl 推导');
  assert.equal(config.maxChars, 20_000);
  assert.equal(config.trustSystemCa, 'auto');
  assert.equal(config.configWarnings.length, 4, config.configWarnings.join('\n'));
  for (const field of ['wikiBaseUrl', 'articlePath', 'maxChars', 'trustSystemCa']) {
    assert.ok(config.configWarnings.some((line) => line.includes(field)), `缺少 ${field} 的告警：\n${config.configWarnings.join('\n')}`);
  }
});

test('normalizeConfig：其余坏字段也逐个告警（类型、数组项、上限夹紧、坏正则）', () => {
  const config = normalizeConfig({
    userAgent: 42,
    requestTimeoutMs: '20000',
    maxListedItems: 0,
    cacheTtlMs: -1,
    cacheMaxEntries: 0,
    throttleAttempts: 99,
    throttleBaseDelayMs: Number.NaN,
    throttleMaxWaitMs: 'x',
    webFallback: 'yes',
    keepImages: 'true',
    dropClasses: 'navbox',
    dropClassPrefixes: ['ok', 3, '  '],
    noisePatterns: ['[', 5],
  });
  assert.equal(config.userAgent.includes('dsh-prts'), true);
  assert.equal(config.requestTimeoutMs, 20_000);
  assert.equal(config.maxListedItems, 50);
  assert.equal(config.cacheTtlMs, 300_000);
  assert.equal(config.cacheMaxEntries, 24);
  assert.equal(config.throttleAttempts, 6, '超过上限夹紧到 6');
  assert.equal(config.throttleBaseDelayMs, 1200);
  assert.equal(config.throttleMaxWaitMs, 10_000);
  assert.equal(config.webFallback, true);
  assert.equal(config.keepImages, false);
  assert.deepEqual(config.dropClassPrefixes, ['ok'], '非字符串项被忽略');
  assert.deepEqual(config.noisePatterns, ['['], '非字符串项被忽略，坏正则保留但不生效');
  for (const field of ['userAgent', 'requestTimeoutMs', 'maxListedItems', 'cacheTtlMs', 'cacheMaxEntries',
    'throttleAttempts', 'throttleBaseDelayMs', 'throttleMaxWaitMs', 'webFallback', 'keepImages', 'dropClasses',
    'dropClassPrefixes', 'noisePatterns']) {
    assert.ok(config.configWarnings.some((line) => line.includes(field)), `缺少 ${field} 的告警：\n${config.configWarnings.join('\n')}`);
  }
  assert.ok(config.configWarnings.some((line) => line.includes('不是合法正则')), '坏正则要提示');
});

test('normalizeConfig：apply 时把每条配置告警都记进 warn 日志', async () => {
  const { warnings } = await boot({ wikiBaseUrl: 'bad', maxChars: -1, trustSystemCa: 'nope' });
  const logged = warnings.filter((line) => line.includes('[prts]') && line.includes('已回退'));
  assert.equal(logged.length, 3, warnings.join('\n'));
});

test('prts_status：报出站点身份、通道、缓存与配置', async () => {
  const { tools } = await boot();
  const { text } = await call(tools, 'prts_status');
  assert.ok(text.includes('PRTS 连通正常'), text);
  assert.ok(text.includes('MediaWiki 1.43.9'), text);
  assert.ok(text.includes('通道：直连，尝试 1 次'), text);
  assert.ok(text.includes('页面 80893'), text);
  assert.ok(text.includes('User-Agent：dsh-prts'), text);
  assert.ok(text.includes('articlePath=/w/$1'), text);
});

test('prts_status：连不上时给可执行建议；接口报错时如实上报', async () => {
  const offline = await boot({}, { SITEINFO: networkError('ECONNREFUSED') });
  const { text } = await call(offline.tools, 'prts_status');
  assert.ok(text.includes('连通失败'), text);
  assert.ok(text.includes('加速'), text);

  const rejected = await boot({}, { SITEINFO: jsonResponse(API_ERROR_BADVALUE) });
  const second = await call(rejected.tools, 'prts_status');
  assert.ok(second.text.includes('badvalue'), second.text);
  assert.ok(second.text.includes('建议：'), second.text);
});

test('prts_search：wikitext 片段被归约，翻页与命名空间都在', async () => {
  const { tools } = await boot();
  const { text } = await call(tools, 'prts_search', { query: '能天使' });
  assert.ok(text.includes('共 10 条命中'), text);
  assert.ok(text.includes('能天使的中坚信物'), text);
  assert.ok(text.includes('模板:模板:材料') === false, '命名空间前缀不能重复拼');
  assert.ok(text.includes('模板:材料'), text);
  assert.ok(!text.includes('searchmatch'), text);
  assert.ok(!text.includes('{{'), text);
  assert.ok(text.includes('下一页用 offset=2'), text);
});

test('prts_search：无命中时说明本站没有 CirrusSearch 语法', async () => {
  const { tools } = await boot({}, { SEARCH: jsonResponse(SEARCH_EMPTY) });
  const { text } = await call(tools, 'prts_search', { query: '不存在的词' });
  assert.ok(text.includes('没有命中'), text);
  assert.ok(text.includes('CirrusSearch'), text);
});

test('prts_search：接口报错如实上报', async () => {
  const { tools } = await boot({}, { SEARCH: jsonResponse(API_ERROR_BADVALUE) });
  const { text } = await call(tools, 'prts_search', { query: 'x', limit: 200 });
  assert.ok(text.includes('badvalue'), text);
  assert.ok(text.includes('建议：'), text);
});

test('prts_titles：前缀候选与 allpages 兜底', async () => {
  const { tools } = await boot();
  const { text } = await call(tools, 'prts_titles', { query: '阿米娅' });
  assert.ok(text.includes('阿米娅(医疗)/语音记录'), text);
  assert.ok(text.includes('https://prts.wiki/w/'), text);

  const fallback = await boot({}, { PREFIXSEARCH: jsonResponse(PREFIX_SEARCH_EMPTY) });
  const second = await call(fallback.tools, 'prts_titles', { query: '龙门' });
  assert.ok(second.text.includes('allpages 前缀枚举'), second.text);
  assert.ok(second.text.includes('龙门币'), second.text);

  const empty = await boot({}, { PREFIXSEARCH: jsonResponse(PREFIX_SEARCH_EMPTY), ALLPAGES: jsonResponse(ALL_PAGES_EMPTY) });
  const third = await call(empty.tools, 'prts_titles', { query: 'zzz' });
  assert.ok(third.text.includes('没有以'), third.text);
});

test('prts_sections：目录带每节字符数，模板页同样有效', async () => {
  const { tools } = await boot();
  const { text } = await call(tools, 'prts_sections', { title: '阿米娅' });
  assert.ok(text.includes('共 3 节'), text);
  for (const title of ['干员信息', '属性', '天赋']) assert.ok(text.includes(title), text);
  assert.ok(text.includes('section=1, level=2'), text);
  assert.ok(text.includes('引言（第一个标题之前'), text);
});

test('prts_sections：没有分节的页面明确说明', async () => {
  const { tools } = await boot({}, { PAGETEXT: jsonResponse(PAGE_TEXT_FLAT) });
  const { text } = await call(tools, 'prts_sections', { title: '某数据页' });
  assert.ok(text.includes('没有可用的分节'), text);
});

test('prts_page：整页干净、SMW 数据与页签内容都在、脚本没有泄漏', async () => {
  const { tools } = await boot();
  const { text } = await call(tools, 'prts_page', { title: '阿米娅' });
  assert.ok(text.includes('# 阿米娅'), text);
  assert.ok(text.includes('来源：https://prts.wiki/w/'), text);
  assert.ok(text.includes('范围：整页'), text);
  assert.ok(text.includes('revid：404892'), text);
  assert.ok(text.includes('分节：共 3 节'), text);
  // 数据必须保留（SMW 是数据本身）
  assert.ok(text.includes('再部署时间'), text);
  assert.ok(text.includes('70s'), text);
  assert.ok(text.includes('| 生命上限 | 699 | 958 | 1198 | 1480 |'), text);
  // 页签的 display:none 内容必须保留
  assert.ok(text.includes('未选中页签的正文（要保留）'), text);
  // 噪声必须丢掉
  for (const noise of ['导航：干员列表', '提示文字', '隐藏数据', '悬浮提示正文不该出现']) {
    assert.ok(!text.includes(noise), `不该出现噪声「${noise}」：\n${text.slice(0, 400)}`);
  }
  // 脚本内容一个字都不该漏出来（回归：旧实现会吞掉整页）
  for (const leaked of ['document.write', 'var tpl', 'class="x"']) {
    assert.ok(!text.includes(leaked), `脚本内容泄漏：${leaked}`);
  }
});

test('prts_page：section=N 只返回那一节；越界给目录；引言可用', async () => {
  const { tools } = await boot();
  const first = await call(tools, 'prts_page', { title: '阿米娅', section: 1 });
  assert.ok(first.text.includes('范围：section=1「干员信息」'), first.text);
  assert.ok(first.text.includes('| 代号 | 阿米娅 |'), first.text);
  assert.ok(!first.text.includes('## 属性'), '不该带出下一节');

  const out = await call(tools, 'prts_page', { title: '阿米娅', section: 99 });
  assert.ok(out.text.includes('section=99 超出范围'), out.text);
  assert.ok(out.text.includes('共 3 节'), out.text);

  const lead = await call(tools, 'prts_page', { title: '阿米娅', section: 0 });
  assert.ok(lead.text.includes('范围：引言'), lead.text);
});

test('prts_page：wikitext 模式、缺失页候选、截断', async () => {
  const { tools } = await boot();
  const wiki = await call(tools, 'prts_page', { title: '龙门币', format: 'wikitext' });
  assert.ok(wiki.text.includes('```wikitext'), wiki.text);
  assert.ok(wiki.text.includes('{{材料'), wiki.text);

  const missing = await boot({}, { PAGETEXT: jsonResponse(API_ERROR_MISSINGTITLE) });
  const second = await call(missing.tools, 'prts_page', { title: '不存在页' });
  assert.ok(second.text.includes('页面「不存在页」不存在'), second.text);
  assert.ok(second.text.includes('相近标题'), second.text);

  const cut = await call(tools, 'prts_page', { title: '阿米娅', maxChars: 80 });
  assert.ok(cut.text.includes('已截断'), cut.text);
  assert.ok(cut.text.includes('prts_sections'), cut.text);
});

test('prts_page：非 missingtitle 的接口错误走统一上报', async () => {
  const { tools } = await boot({}, { PAGETEXT: jsonResponse(API_ERROR_PARAM) });
  const { text } = await call(tools, 'prts_page', { title: '阿米娅' });
  assert.ok(text.includes('badvalue'), text);
  assert.ok(text.includes('建议：'), text);
});

test('prts_page_info：元数据、分类剥离、最后编辑与阅读入口', async () => {
  const { tools } = await boot();
  const { text } = await call(tools, 'prts_page_info', { title: '阿米娅(医疗)/语音记录' });
  assert.ok(text.includes('# 阿米娅(医疗)/语音记录'), text);
  assert.ok(text.includes('命名空间 0（主条目）'), text);
  assert.ok(text.includes('分类（2）：干员、对原文有修正的页面'), text);
  assert.ok(text.includes('由 BotPtilopsis'), text);
  assert.ok(text.includes('摘要：机器人：更新语音'), text);
  assert.ok(text.includes('重定向自：阿米娅(医疗)/语音'), text);
  assert.ok(text.includes('页面属性：displaytitle'), text);
  assert.ok(text.includes('prts_category(category="干员")'), text);
  assert.ok(!text.includes('prts_category(category="对原文有修正'), '维护类分类不该当阅读入口');
});

test('prts_page_info：页面不存在时给相近标题', async () => {
  const { tools } = await boot({}, { PAGEINFO: jsonResponse(PAGE_INFO_MISSING) });
  const { text } = await call(tools, 'prts_page_info', { title: '这个页面肯定不存在xyz123' });
  assert.ok(text.includes('不存在'), text);
  assert.ok(text.includes('相近标题'), text);
});

test('prts_links：出链与反链的标题原样打印', async () => {
  const { tools } = await boot();
  const out = await call(tools, 'prts_links', { title: '阿米娅' });
  assert.ok(out.text.includes('模板:干员'), out.text);
  assert.ok(!out.text.includes('模板:模板:'), out.text);

  const back = await call(tools, 'prts_links', { title: '阿米娅', direction: 'in' });
  assert.ok(back.text.includes('模板:关卡报酬/doc'), back.text);
  assert.ok(back.text.includes('阿米娅（经由重定向）'), back.text);
});

test('prts_category：本地化分类名换成规范 cmtitle', async () => {
  const { tools, calls } = await boot();
  const { text } = await call(tools, 'prts_category', { category: '分类:干员' });
  assert.ok(text.includes('分类:干员 的成员'), text);
  assert.ok(text.includes('12F'), text);
  assert.ok(text.includes('分类:术师干员'), text);
  assert.equal(new URL(calls.at(-1)).searchParams.get('cmtitle'), 'Category:干员');

  const rejected = await boot({}, { CATEGORYMEMBERS: jsonResponse(API_ERROR_PARAM) });
  const second = await call(rejected.tools, 'prts_category', { category: '干员' });
  assert.ok(second.text.includes('badvalue'), second.text);
});

test('prts_recent_changes：微件命名空间与站点时区说明', async () => {
  const { tools } = await boot();
  const { text } = await call(tools, 'prts_recent_changes');
  assert.ok(text.includes('PRTS 最近 7 天的改动'), text);
  assert.ok(text.includes('Asia/Shanghai'), text);
  assert.ok(text.includes('微件:EquipList'), text);
  assert.ok(text.includes('+145'), text);
  assert.ok(text.includes('新建'), text);
});

test('缓存：同一 URL 命中缓存，fresh 绕过', async () => {
  const { tools, calls } = await boot({ cacheTtlMs: 60_000 });
  await call(tools, 'prts_status');
  await call(tools, 'prts_status');
  assert.equal(calls.filter((url) => url.includes('siteinfo')).length, 1, '第二次应命中缓存');
  await call(tools, 'prts_status', { fresh: true });
  assert.equal(calls.filter((url) => url.includes('siteinfo')).length, 2, 'fresh 应绕过缓存');
});

test('节流：首次被拦下时重试后照常返回结果', async () => {
  let first = true;
  const { tools, calls } = await boot({}, {
    PAGETEXT: () => {
      const response = first ? htmlResponse(567) : jsonResponse(PAGE_TEXT);
      first = false;
      return response;
    },
  });
  const { text } = await call(tools, 'prts_page', { title: '阿米娅' });
  assert.equal(calls.filter((url) => url.includes('action=parse')).length, 2);
  assert.ok(text.includes('1480'), text);
});

test('一直被拦时给出可执行的错误，而不是解析崩栈', async () => {
  const { tools } = await boot({ throttleAttempts: 2 }, { PAGETEXT: htmlResponse(567) });
  await assert.rejects(
    () => call(tools, 'prts_page', { title: '阿米娅' }),
    (error) => {
      assert.ok(error.message.includes('读取页面失败'), error.message);
      assert.ok(/567|CDN/.test(error.message), error.message);
      return true;
    },
  );
});

// ---------------------------------------------------------------- 命名空间 / 警告

test('prts_search：namespace 名字经 siteinfo 解析成数字 id（不再被静默忽略）', async () => {
  const { tools, calls } = await boot();
  const { text } = await call(tools, 'prts_search', { query: '干员', namespace: '模板' });
  const searchUrl = calls.find((rawUrl) => new URL(rawUrl).searchParams.get('list') === 'search');
  assert.equal(new URL(searchUrl).searchParams.get('srnamespace'), '10', '必须真的只搜模板命名空间');
  assert.ok(text.includes('命名空间 模板'), text);

  const canonical = await boot();
  await call(canonical.tools, 'prts_search', { query: '干员', namespace: 'Template' });
  const canonicalUrl = canonical.calls.find((rawUrl) => new URL(rawUrl).searchParams.get('list') === 'search');
  assert.equal(new URL(canonicalUrl).searchParams.get('srnamespace'), '10');
});

test('prts_search：不认识的命名空间名字给可执行错误', async () => {
  const { tools } = await boot();
  await assert.rejects(
    () => call(tools, 'prts_search', { query: 'x', namespace: '不存在的命名空间' }),
    /不认识的命名空间/,
  );
});

test('五个列表工具都会把接口 warnings 显示出来', async () => {
  const warning = (body) => jsonResponse({ ...body, warnings: { query: { warnings: '警告文本X' } } });
  const cases = [
    ['prts_search', { query: '材料' }, 'SEARCH', SEARCH],
    ['prts_titles', { query: '阿米娅' }, 'PREFIXSEARCH', PREFIX_SEARCH],
    ['prts_links', { title: '阿米娅' }, 'LINKS', LINKS],
    ['prts_category', { category: '干员' }, 'CATEGORYMEMBERS', CATEGORY_MEMBERS],
    ['prts_recent_changes', {}, 'RECENTCHANGES', RECENT_CHANGES],
  ];
  for (const [toolName, args, route, fixtureBody] of cases) {
    const { tools } = await boot({}, { [route]: warning(fixtureBody) });
    const { text } = await call(tools, toolName, args);
    assert.ok(text.includes('警告文本X'), `${toolName} 没有显示接口警告：\n${text}`);
    assert.ok(text.includes('接口警告'), `${toolName} 没有显示接口警告：\n${text}`);
  }
});

test('prts_search：offset 越界提示「offset 超出命中范围（共 N 条）」而不是「没有命中」', async () => {
  const { tools } = await boot({}, { SEARCH: jsonResponse(SEARCH_OFFSET_PAST) });
  const { text } = await call(tools, 'prts_search', { query: '能天使', offset: 10 });
  assert.ok(text.includes('offset 超出命中范围（共 5 条）'), text);
  assert.ok(!text.includes('没有命中'), text);
});

// ---------------------------------------------------------------- 页面 / wikitext

test('prts_page：format="wikitext" 把 section 传给 action=parse，nosuchsection 走错误映射', async () => {
  const { tools, calls } = await boot();
  const { text } = await call(tools, 'prts_page', { title: '龙门币', format: 'wikitext', section: 2 });
  const wikiUrl = calls.find((rawUrl) => String(new URL(rawUrl).searchParams.get('prop')).includes('wikitext'));
  assert.equal(new URL(wikiUrl).searchParams.get('section'), '2');
  assert.ok(text.includes('范围：wikitext section=2'), text);
  assert.ok(text.includes('```wikitext'), text);

  const missing = await boot({}, { WIKITEXT: jsonResponse(API_ERROR_NOSUCHSECTION) });
  const second = await call(missing.tools, 'prts_page', { title: '阿米娅', format: 'wikitext', section: 999 });
  assert.ok(second.text.includes('nosuchsection'), second.text);
  assert.ok(second.text.includes('section=999 不存在'), second.text);

  // 截断提示：wikitext 的节号与渲染目录无关，不该再让人去看 prts_sections
  const cut = await call(tools, 'prts_page', { title: '龙门币', format: 'wikitext', maxChars: 10 });
  assert.ok(cut.text.includes('已截断'), cut.text);
  assert.ok(cut.text.includes('提高 maxChars'), cut.text);
  assert.ok(!cut.text.includes('prts_sections 看目录'), cut.text);
});

test('prts_sections / prts_page：父节包含子节正文，字符数与切片一致', async () => {
  const { tools } = await boot();
  const outline = await call(tools, 'prts_sections', { title: '阿米娅' });
  assert.ok(outline.text.includes('含 1 个子节正文'), outline.text);
  assert.ok(outline.text.includes('父节包含子节正文'), outline.text);

  const parent = await call(tools, 'prts_page', { title: '阿米娅', section: 2 });
  assert.ok(parent.text.includes('## 属性'), parent.text);
  assert.ok(parent.text.includes('### 天赋'), parent.text, '父节应包含子节正文');
});

// ---------------------------------------------------------------- 反链 / 分类 / 翻页

test('prts_links(direction="in")：backlinks 与 embeddedin 两组都查、各带自己的 continue', async () => {
  const { tools } = await boot();
  const { text } = await call(tools, 'prts_links', { title: '阿米娅', direction: 'in' });
  assert.ok(text.includes('## 页面链接（list=backlinks，本次 3 条）'), text);
  assert.ok(text.includes('模板:关卡报酬/doc'), text);
  assert.ok(text.includes('阿米娅（经由重定向）'), text);
  assert.ok(text.includes('## 模板嵌入（list=embeddedin，本次 2 条）'), text);
  assert.ok(text.includes('Lancet-2'), text);
  assert.ok(text.includes('"blcontinue"'), text);
  assert.ok(text.includes('"eicontinue"'), text);
  assert.ok(text.includes('还有更多，继续取下一页：continue='), text);
});

test('导航类工具也解析命名空间名字（links 两组 + recent_changes）', async () => {
  const links = await boot();
  await call(links.tools, 'prts_links', { title: '阿米娅', direction: 'in', namespace: '模板' });
  const back = links.calls.filter((rawUrl) => new URL(rawUrl).searchParams.get('list') === 'backlinks').at(-1);
  const embed = links.calls.filter((rawUrl) => new URL(rawUrl).searchParams.get('list') === 'embeddedin').at(-1);
  assert.equal(new URL(back).searchParams.get('blnamespace'), '10');
  assert.equal(new URL(embed).searchParams.get('einsnamespace'), '10');

  const recent = await boot();
  await call(recent.tools, 'prts_recent_changes', { namespace: '微件' });
  const rc = recent.calls.filter((rawUrl) => new URL(rawUrl).searchParams.get('list') === 'recentchanges').at(-1);
  assert.equal(new URL(rc).searchParams.get('rcnamespace'), '274');

  await assert.rejects(
    () => call(links.tools, 'prts_links', { title: '阿米娅', direction: 'in', namespace: '不存在' }),
    /不认识的命名空间/,
  );
});

test('prts_links：空结果先区分「页面不存在」与「没有」', async () => {
  const missing = await boot({}, { PAGEEXISTS: jsonResponse(PAGE_INFO_MISSING) });
  const first = await call(missing.tools, 'prts_links', { title: '不存在页', direction: 'in' });
  assert.ok(first.text.includes('页面「不存在页」不存在'), first.text);

  const empty = await boot({}, {
    BACKLINKS: jsonResponse(BACKLINKS_EMPTY),
    EMBEDDEDIN: jsonResponse(EMBEDDEDIN_EMPTY),
  });
  const second = await call(empty.tools, 'prts_links', { title: '阿米娅', direction: 'in' });
  assert.ok(second.text.includes('没有页面在正文里链接到它'), second.text);
  assert.ok(second.text.includes('没有页面嵌入（引用）它'), second.text);
});

test('prts_category：空结果区分「分类不存在」与「分类没有成员」', async () => {
  const missing = await boot({}, {
    PAGEEXISTS: jsonResponse(PAGE_INFO_MISSING),
    CATEGORYMEMBERS: jsonResponse(CATEGORY_MEMBERS_EMPTY),
  });
  const first = await call(missing.tools, 'prts_category', { category: '不存在的分类' });
  assert.ok(first.text.includes('分类「分类:不存在的分类」不存在'), first.text);

  const empty = await boot({}, { CATEGORYMEMBERS: jsonResponse(CATEGORY_MEMBERS_EMPTY) });
  const second = await call(empty.tools, 'prts_category', { category: '空分类' });
  assert.ok(second.text.includes('分类「分类:空分类」没有成员'), second.text);
});

test('列表翻页：continue 原样回传并回显下一次 token', async () => {
  const category = await boot();
  const first = await call(category.tools, 'prts_category', { category: '干员' });
  assert.ok(first.text.includes('继续取下一页：continue={"cmcontinue":"page|417263686572|18685"'), first.text);
  await call(category.tools, 'prts_category', {
    category: '干员',
    continue: '{"cmcontinue":"page|417263686572|18685","continue":"-||"}',
  });
  const categoryCalls = category.calls.filter((rawUrl) => new URL(rawUrl).searchParams.get('list') === 'categorymembers');
  const last = new URL(categoryCalls.at(-1)).searchParams;
  assert.equal(last.get('cmcontinue'), 'page|417263686572|18685');
  assert.equal(last.get('continue'), '-||');

  const recent = await boot();
  const recentText = await call(recent.tools, 'prts_recent_changes');
  assert.ok(recentText.text.includes('继续取下一页：continue={"rccontinue"'), recentText.text);

  const links = await boot();
  const linksText = await call(links.tools, 'prts_links', { title: '阿米娅' });
  assert.ok(linksText.text.includes('继续取下一页：continue={"plcontinue"'), linksText.text);

  // 裸 token 也认（当成该列表的主键）
  const bare = await boot();
  await call(bare.tools, 'prts_links', { title: '阿米娅', continue: '1751|0|12F' });
  const linkCalls = bare.calls.filter((rawUrl) => new URL(rawUrl).searchParams.get('prop') === 'links');
  assert.equal(new URL(linkCalls.at(-1)).searchParams.get('plcontinue'), '1751|0|12F');

  await assert.rejects(
    () => call(category.tools, 'prts_category', { category: '干员', continue: '{bad' }),
    /continue 参数格式不对/,
  );
});

test('maxListedItems：links / category / recent_changes 的上限来自配置', async () => {
  const { tools, calls } = await boot({ maxListedItems: 7 });
  await call(tools, 'prts_links', { title: '阿米娅', limit: 999 });
  await call(tools, 'prts_category', { category: '干员', limit: 999 });
  await call(tools, 'prts_recent_changes', { limit: 999 });
  const queryOf = (predicate) => new URL(calls.filter(predicate).at(-1)).searchParams;
  assert.equal(queryOf((rawUrl) => new URL(rawUrl).searchParams.get('prop') === 'links').get('pllimit'), '7');
  assert.equal(queryOf((rawUrl) => new URL(rawUrl).searchParams.get('list') === 'categorymembers').get('cmlimit'), '7');
  assert.equal(queryOf((rawUrl) => new URL(rawUrl).searchParams.get('list') === 'recentchanges').get('rclimit'), '7');
});

test('prts_titles：hasMore 给出 offset 续取提示，offset 传到 psoffset；allpages 兜底也提示还有更多', async () => {
  const { tools, calls } = await boot();
  const { text } = await call(tools, 'prts_titles', { query: '阿米娅' });
  assert.ok(text.includes('还有更多（用 offset=3 继续）'), text);
  await call(tools, 'prts_titles', { query: '阿米娅', offset: 3 });
  const prefixCalls = calls.filter((rawUrl) => new URL(rawUrl).searchParams.get('list') === 'prefixsearch');
  assert.equal(new URL(prefixCalls.at(-1)).searchParams.get('psoffset'), '3');

  const fallback = await boot({}, { PREFIXSEARCH: jsonResponse(PREFIX_SEARCH_EMPTY) });
  const listed = await call(fallback.tools, 'prts_titles', { query: '龙门' });
  assert.ok(listed.text.includes('还有更多（前缀枚举不支持 offset'), listed.text);
});

test('fresh 透传：prts_page_info 的 fresh 会绕过 siteinfo 缓存', async () => {
  const { tools, calls } = await boot();
  const siteInfoCalls = () => calls.filter((rawUrl) => new URL(rawUrl).searchParams.get('meta') === 'siteinfo').length;
  await call(tools, 'prts_page_info', { title: '阿米娅(医疗)/语音记录' });
  await call(tools, 'prts_page_info', { title: '阿米娅(医疗)/语音记录' });
  assert.equal(siteInfoCalls(), 1, 'TTL 内 siteinfo 只取一次');
  await call(tools, 'prts_page_info', { title: '阿米娅(医疗)/语音记录', fresh: true });
  assert.equal(siteInfoCalls(), 2, 'fresh 应绕过 siteinfo 缓存');
});

test('取消语义：每个工具在 abort 时都抛 AbortError（经 unwrap/abortError 透传）', async () => {
  const { tools } = await boot();
  const argsByTool = {
    prts_status: {},
    prts_search: { query: 'x' },
    prts_titles: { query: 'x' },
    prts_page: { title: '阿米娅' },
    prts_sections: { title: '阿米娅' },
    prts_page_info: { title: '阿米娅' },
    prts_links: { title: '阿米娅' },
    prts_category: { category: '干员' },
    prts_recent_changes: {},
    prts_operator: { title: '阿米娅' },
  };
  const controller = new AbortController();
  controller.abort();
  for (const [toolName, args] of Object.entries(argsByTool)) {
    const definition = tools.get(toolName);
    await assert.rejects(
      () => definition.execute(args, { signal: controller.signal }),
      (error) => {
        assert.equal(error.name, 'AbortError', `${toolName} 应抛 AbortError，实际 ${error.name}：${error.message}`);
        return true;
      },
    );
  }
});
