/**
 * 联网冒烟测试：逐工具打真站（`prts.wiki`）。
 *
 * 默认跳过，需要显式打开：
 *
 *     $env:DSH_PRTS_LIVE=1; node --test test/live.test.js
 *
 * 断言写得**宽容**（站点内容随时会更新，不写死具体数值），但覆盖三件关键事：
 * 分节与切片、SMW 数据必须保留（`龙门币` 的掉落表）、以及页面能真读出正文。
 *
 * @module dsh-prts/test/live
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

const LIVE = process.env.DSH_PRTS_LIVE === '1';

/** 装配插件（真实 fetch）。 */
async function boot() {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`工具名重复：${definition.name}`);
        tools.set(definition.name, definition);
      },
    },
    get() {
      return undefined;
    },
    logger: { info() {}, warn() {} },
  };
  await apply(ctx, { requestTimeoutMs: 30_000, throttleBaseDelayMs: 1000, throttleAttempts: 3 });
  return tools;
}

/**
 * 调用工具并返回文本；遇到 CDN/WAF 拦截整体重试（真站偶发，不该让冒烟变红灯）。
 * @param {Map<string, any>} tools - 工具表。
 * @param {string} toolName - 工具名。
 * @param {object} [args] - 参数。
 * @returns {Promise<string>} 文本。
 */
async function call(tools, toolName, args = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const value = await tools.get(toolName).execute(args, { signal: AbortSignal.timeout(60_000) });
      return String(value.text);
    } catch (error) {
      const message = String(error?.message ?? '');
      if (attempt < 3 && /567|CDN|拦截|HTML/.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error('unreachable');
}

test('live：prts_status 连通并报出站点信息', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_status');
  assert.ok(text.includes('连通正常'), text);
  assert.ok(text.includes('PRTS'), text);
  assert.ok(text.includes('MediaWiki 1.43'), text);
  assert.ok(text.includes('/w/$1'), text);
});

test('live：prts_search 有命中且片段已做 wikitext 归约', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_search', { query: '能天使', limit: 5 });
  assert.ok(text.includes('条命中') || text.includes('没有命中'), text);
  assert.ok(!text.includes('searchmatch'), text);
  assert.ok(!text.includes('{{'), text);
});

test('live：prts_search 对不存在的词给建议', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_search', { query: '这个检索词肯定不存在xyz123' });
  assert.ok(text.includes('没有命中'), text);
});

test('live：prts_titles 按前缀给候选与规范 URL', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_titles', { query: '阿米娅' });
  assert.ok(text.includes('阿米娅'), text);
  assert.ok(text.includes('https://prts.wiki/w/'), text);
});

test('live：prts_sections 给出多节目录（模板驱动的干员页）', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_sections', { title: '阿米娅' });
  assert.ok(text.includes('的目录'), text);
  const count = Number((/共 (\d+) 节/.exec(text) || [])[1] ?? 0);
  assert.ok(count >= 8, `节数应当可观（实际 ${count}）：\n${text.slice(0, 400)}`);
  assert.ok(text.includes('属性'), text);
  assert.ok(text.includes('section=1'), text);
});

test('live：prts_page 读出正文（含 SMW 属性数据）', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_page', { title: '阿米娅' });
  assert.ok(text.includes('阿米娅'), text);
  assert.ok(text.includes('来源：https://prts.wiki/w/'), text);
  assert.ok(text.length > 5000, `正文太短（${text.length} 字符），可能被噪声规则误删`);
  assert.ok(text.includes('生命上限') || text.includes('再部署时间'), '属性数据应当保留');
  assert.ok(text.includes('|'), '表格应当降成竖线行');
});

test('live：prts_page(section=N) 切片短于整页，且越界给目录', { skip: !LIVE }, async () => {
  const tools = await boot();
  const whole = await call(tools, 'prts_page', { title: '阿米娅' });
  const first = await call(tools, 'prts_page', { title: '阿米娅', section: 1 });
  assert.ok(first.includes('范围：section=1'), first);
  assert.ok(first.length < whole.length, '单节应当短于整页');

  const out = await call(tools, 'prts_page', { title: '阿米娅', section: 999 });
  assert.ok(out.includes('超出范围'), out);
});

test('live：龙门币的掉落表（SMW 数据）必须在——这是 smw 规则的回归锚点', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_page', { title: '龙门币' });
  assert.ok(text.includes('龙门币'), text);
  // 单元格里的列表按「一行一格」归约后不再输出 `- ` 行，但**数据本体必须还在**：
  // 掉落表的表头与若干整行。
  assert.ok(text.includes('| 地点 | 理智 | 掉落总量 | 理智效率 |'), text.slice(0, 2500));
  const rows = text.split('\n').filter((line) => /^\| .+ \| .+ \|$/.test(line));
  assert.ok(rows.length >= 10, `掉落表应当保留若干行（实际 ${rows.length} 行）：\n${text.slice(0, 800)}`);
  assert.ok(text.includes('固定掉落'), 'SMW 字段文本必须保留');
});

test('live：prts_search(namespace="模板") 真的只搜模板命名空间', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_search', { query: '干员', namespace: '模板', limit: 5 });
  assert.ok(text.includes('命名空间 模板'), text);
  assert.ok(!text.includes('不认识的命名空间'), text);
  // 命中条目的命名空间前缀都应是「模板:」
  const itemLines = text.split('\n').filter((line) => /^\d+\. /u.test(line));
  assert.ok(itemLines.length > 0, text);
  for (const line of itemLines) assert.ok(line.includes('模板:'), `不该混入其它命名空间：${line}`);
});

test('live：prts_links(direction="in") 合并模板嵌入（模板:CharinfoV2 的使用者）', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_links', { title: '模板:CharinfoV2', direction: 'in', limit: 3 });
  assert.ok(text.includes('## 页面链接（list=backlinks'), text);
  assert.ok(text.includes('## 模板嵌入（list=embeddedin'), text);
  assert.ok(/## 模板嵌入（list=embeddedin，本次 [1-9]\d* 条）/.test(text), `模板嵌入不该为空：\n${text}`);
});

test('live：prts_page 的 wikitext 模式可以把 section 传给接口', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_page', { title: '阿米娅', format: 'wikitext', section: 2, maxChars: 600 });
  assert.ok(text.includes('范围：wikitext section=2'), text);
  assert.ok(text.includes('```wikitext'), text);
});

test('live：prts_page 的正文里不应有强调错配留下的孤立标记', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_page', { title: '阿米娅' });
  // `<big>`/`<img>` 误当 `<b>`/`<i>` 时，行内会出现奇数个 `**`；这里逐行检查配对。
  const odd = text.split('\n').filter((line) => (line.match(/\*\*/g) || []).length % 2 === 1);
  assert.deepEqual(odd, [], `这些行的粗体标记没有配对：\n${odd.join('\n')}`);
});

test('live：prts_operator 的 CV 会显示中/日/韩/英（有就显示）', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_operator', { title: '阿米娅' });
  assert.match(text, /CV：.*（中）/);
  assert.match(text, /CV：.*（日）/);
  assert.match(text, /CV：.*（韩）/);
  assert.match(text, /CV：.*（英）/);
});

test('live：prts_page 的 wikitext 模式可用', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_page', { title: '龙门币', format: 'wikitext', maxChars: 600 });
  assert.ok(text.includes('```wikitext'), text);
});

test('live：页面不存在时给候选而不是报错', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_page', { title: '这个页面肯定不存在xyz123' });
  assert.ok(text.includes('不存在'), text);
});

test('live：prts_page_info 读到元数据与分类', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_page_info', { title: '阿米娅' });
  assert.ok(text.includes('# 阿米娅'), text);
  assert.ok(text.includes('pageid'), text);
  assert.ok(text.includes('分类'), text);
  assert.ok(text.includes('revid'), text);
});

test('live：prts_links 出链与反链', { skip: !LIVE }, async () => {
  const tools = await boot();
  const out = await call(tools, 'prts_links', { title: '阿米娅', limit: 5 });
  assert.ok(out.includes('出链'), out);
  const back = await call(tools, 'prts_links', { title: '阿米娅', direction: 'in', limit: 5 });
  assert.ok(back.includes('链接到'), back);
});

test('live：prts_category 列分类成员', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_category', { category: '干员', limit: 5 });
  assert.ok(text.includes('的成员') || text.includes('没有成员'), text);
});

test('live：prts_recent_changes 带时区说明', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_recent_changes', { limit: 5 });
  assert.ok(text.includes('Asia/Shanghai'), text);
  assert.ok(text.includes('改动'), text);
});

test('live：prts_operator 解析能天使档案（wikitext 模板）', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_operator', { title: '能天使' });
  assert.ok(text.includes('稀有度：6★'), text);
  assert.ok(text.includes('职业：狙击'), text);
  assert.ok(text.includes('分支：速射手'), text);
  assert.ok(text.includes('来源：https://prts.wiki/'), text);
  assert.ok(!text.includes('{{'), '不应漏出 wikitext 模板原文');
});

test('live：prts_operator 对非干员页降级为正文提示', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'prts_operator', { title: '龙门币' });
  assert.ok(text.includes('没有找到 {{CharinfoV2}}'), text);
  assert.ok(text.includes('prts_page'), text);
});
