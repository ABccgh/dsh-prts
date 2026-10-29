/**
 * `prts_operator` 的离线测试：真实形状夹具（能天使/阿米娅）、缺模板降级、网络错误降级、
 * 页面不存在候选、缓存与 fresh、以及纯函数（rarityOf / cleanInline / describeAttributes）。
 *
 * 出网用假 fetch 注入（`apply(ctx, config, { fetchImpl })`），不联网。
 *
 * @module dsh-prts/test/operator
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import {
  cleanInline,
  describeAttributes,
  rarityOf,
  readOperatorFromWikitext,
} from '../lib/tools/operator.js';
import {
  API_ERROR_MISSINGTITLE,
  OPERATOR_WIKITEXT_AMIYA,
  OPERATOR_WIKITEXT_ANGEL,
  OPERATOR_WIKITEXT_NOT_OPERATOR,
  PREFIX_SEARCH,
} from './fixtures/fixtures.js';

/** JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** 造一个最小上下文，记录工具注册。 */
function makeCtx() {
  const tools = new Map();
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
    logger: { info() {}, warn() {} },
  };
  return { ctx, tools };
}

/**
 * 装配插件。
 * @param {Function} fetchImpl - 按 URL 返回 Response 的假实现。
 * @param {Record<string, any>} [config] - 覆盖配置。
 * @returns {Promise<{ tools: Map<string, any>, calls: string[] }>} 结果。
 */
async function boot(fetchImpl, config = {}) {
  const { ctx, tools } = makeCtx();
  const calls = [];
  await apply(ctx, { throttleBaseDelayMs: 0, cacheTtlMs: 60_000, ...config }, {
    fetchImpl: async (rawUrl) => {
      calls.push(String(rawUrl));
      return fetchImpl(String(rawUrl));
    },
  });
  return { tools, calls };
}

/** 调用工具。 */
function call(tools, toolName, args = {}) {
  const definition = tools.get(toolName);
  assert.ok(definition, `工具 ${toolName} 没有注册`);
  return definition.execute(args, { signal: AbortSignal.timeout(10_000) });
}

/**
 * 造一个按页面分发的 PRTS 假路由。
 * @param {Record<string, object|Response|Error>} pages - `页面标题 → wikitext 响应 / Response / Error`。
 * @param {{ prefix?: object, missing?: object }} [options] - 前缀候选与缺失页响应。
 * @returns {Function} fetchImpl。
 */
function operatorRouter(pages, options = {}) {
  return (rawUrl) => {
    const url = new URL(rawUrl);
    const params = url.searchParams;
    if (params.get('list') === 'prefixsearch') return jsonResponse(options.prefix ?? PREFIX_SEARCH);
    if (String(params.get('prop')).includes('wikitext')) {
      const page = params.get('page') ?? '';
      const entry = pages[page];
      if (entry instanceof Error) throw entry;
      if (entry instanceof Response) return entry.clone();
      if (entry !== undefined) return jsonResponse(entry);
      return jsonResponse(options.missing ?? API_ERROR_MISSINGTITLE);
    }
    return jsonResponse({});
  };
}

/** 取工具返回的文本。 */
function toolText(result) {
  assert.equal(typeof result?.text, 'string');
  return result.text;
}

test('prts_operator（能天使）: 解析 CharinfoV2/干员获得方式/属性 的关键字段', async () => {
  const { tools, calls } = await boot(operatorRouter({ 能天使: OPERATOR_WIKITEXT_ANGEL }));
  const text = toolText(await call(tools, 'prts_operator', { title: '能天使' }));

  assert.match(text, /^# 能天使（6★ 狙击 · 速射手）$/m);
  assert.match(text, /稀有度：6★（CharinfoV2 稀有度=5）/);
  assert.match(text, /职业：狙击 \/ 分支：速射手 \/ 位置：远程位/);
  assert.match(text, /标签：输出/);
  assert.match(text, /特性：优先攻击空中单位/);
  assert.match(text, /获得方式：公开招募 中坚寻访/);
  assert.match(text, /上线时间：2019-04-30 10:00/);
  assert.match(text, /阵营\/组织：炎-龙门 · 企鹅物流/);
  assert.match(text, /画师：幻象黑兔/);
  assert.match(text, /CV：蔡书瑾（中） · 石见舞菜香（日）/);
  assert.match(text, /属性：再部署 70s · 部署费用 12→14 · 阻挡数 1 · 攻击速度 1\.0s · 势力 炎-龙门,企鹅物流/);
  assert.match(text, /来源：https:\/\/prts\.wiki\/w\/.+（PRTS，第三方内容；revid 442591）/);
  // 不能漏出 wikitext 噪声。
  assert.doesNotMatch(text, /\{\{/);
  assert.doesNotMatch(text, /<!--/);

  // 请求的是 wikitext（不是渲染 HTML）。
  const request = calls.find((rawUrl) => String(new URL(rawUrl).searchParams.get('prop')).includes('wikitext'));
  assert.ok(request, '应请求 action=parse&prop=wikitext');
  const params = new URL(request).searchParams;
  assert.equal(params.get('action'), 'parse');
  assert.equal(params.get('page'), '能天使');
});

test('prts_operator（阿米娅）: 嵌套 {{color}} 与 <br> 被清洗，缺少组织时只显示国家', async () => {
  const { tools } = await boot(operatorRouter({ 阿米娅: OPERATOR_WIKITEXT_AMIYA }));
  const text = toolText(await call(tools, 'prts_operator', { title: '阿米娅' }));

  assert.match(text, /^# 阿米娅（5★ 术师 · 中坚术师）$/m);
  assert.match(text, /稀有度：5★（CharinfoV2 稀有度=4）/);
  assert.match(text, /特性：攻击造成法术伤害/);
  assert.match(text, /阵营\/组织：罗德岛/);
  assert.match(text, /覆盖：主线剧情 \/ （首次通关主题曲2-10、3-8获取）/);
  assert.doesNotMatch(text, /\{\{/);
});

test('prts_operator: 没有 {{CharinfoV2}} 时降级为正文提示（并保留已找到的获得方式）', async () => {
  const { tools } = await boot(operatorRouter({ 某活动页: OPERATOR_WIKITEXT_NOT_OPERATOR }));
  const text = toolText(await call(tools, 'prts_operator', { title: '某活动页' }));

  assert.match(text, /没有找到 \{\{CharinfoV2\}\}（干员信息）模板/);
  assert.match(text, /已找到 \{\{干员获得方式\}\} · 获得方式：活动奖励/);
  assert.match(text, /prts_titles\(query="某活动页"\)/);
  assert.match(text, /prts_page\(title="某活动页"\)/);
  assert.match(text, /（这不是干员档案页，未输出稀有度等字段。）/);
  assert.doesNotMatch(text, /稀有度：/);
});

test('prts_operator: 网络错误降级为可执行提示（不抛）', async () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const failure = new Error('fetch failed');
  failure.cause = cause;
  const { tools } = await boot(() => {
    throw failure;
  });
  const text = toolText(await call(tools, 'prts_operator', { title: '能天使' }));
  assert.match(text, /读取干员资料失败。/);
  assert.match(text, /建议：/);
  assert.match(text, /请求：https:\/\/prts\.wiki\/api\.php\?/);
});

test('prts_operator: 页面不存在时给相近标题候选', async () => {
  const { tools } = await boot(operatorRouter({}));
  const text = toolText(await call(tools, 'prts_operator', { title: '不存在的干员xyz' }));
  assert.match(text, /页面「不存在的干员xyz」不存在/);
  assert.match(text, /相近标题/);
  assert.match(text, /阿米娅\(医疗\)\/语音记录/);
});

test('prts_operator: 同一页面命中缓存，fresh=true 绕过', async () => {
  const { tools, calls } = await boot(operatorRouter({ 能天使: OPERATOR_WIKITEXT_ANGEL }));
  const pageCalls = () => calls.filter((rawUrl) => new URL(rawUrl).searchParams.get('page') === '能天使').length;
  await call(tools, 'prts_operator', { title: '能天使' });
  await call(tools, 'prts_operator', { title: '能天使' });
  assert.equal(pageCalls(), 1, '第二次应命中缓存');
  await call(tools, 'prts_operator', { title: '能天使', fresh: true });
  assert.equal(pageCalls(), 2, 'fresh 应绕过缓存');
});

test('prts_operator: title 是必填参数', async () => {
  const { tools } = await boot(operatorRouter({}));
  await assert.rejects(() => call(tools, 'prts_operator', {}), /缺少必填参数 title/);
});

test('rarityOf: CharinfoV2 的 0–5 稀有度映射到 1–6 星', () => {
  assert.equal(rarityOf('5'), 6);
  assert.equal(rarityOf('4'), 5);
  assert.equal(rarityOf('0'), 1);
  assert.equal(rarityOf('6'), 6, '越界按 6 星夹紧');
  assert.equal(rarityOf(''), null);
  assert.equal(rarityOf(undefined), null);
  assert.equal(rarityOf('x'), null);
});

test('cleanInline: 剥模板/链接/HTML/注释，保留可读文本', () => {
  assert.equal(cleanInline('攻击造成{{color|#00B0FF|法术伤害}}'), '攻击造成法术伤害');
  assert.equal(cleanInline('[[2-10|{{color|orange|2-10}}]]'), '2-10');
  assert.equal(cleanInline('第一行<br>第二行'), '第一行 / 第二行');
  assert.equal(cleanInline('{{!}}'), '|');
  assert.equal(cleanInline('<!-- 注释 --> 文本 '), '文本');
  assert.equal(cleanInline('<span class="x">值</span>'), '值');
  assert.equal(cleanInline(undefined), '');
});

test('describeAttributes: 只输出可读的常用属性', () => {
  assert.equal(
    describeAttributes({ 再部署: '70s', 部署费用: '12→14', 阻挡数: '1', 攻击速度: '1.0s', 所属势力: '罗德岛' }),
    '再部署 70s · 部署费用 12→14 · 阻挡数 1 · 攻击速度 1.0s · 势力 罗德岛',
  );
  assert.equal(describeAttributes({ 精英2_满级_生命上限: '1673' }), '');
  assert.equal(describeAttributes(null), '');
});

test('readOperatorFromWikitext: 纯函数可从夹具直接解析（不经过网络/插件）', () => {
  const result = readOperatorFromWikitext(OPERATOR_WIKITEXT_ANGEL.parse.wikitext, { title: '能天使' });
  assert.equal(result.found, true);
  assert.equal(result.stars, 6);
  assert.equal(result.lines[0], '# 能天使（6★ 狙击 · 速射手）');
  assert.ok(result.lines.some((line) => line === '获得方式：公开招募 中坚寻访'));
  assert.equal(result.truncated, false);
});
