/**
 * 归约器的离线测试（不联网）。
 *
 * 最重要的一条是 **原始文本元素** 的回归：内联脚本里含 HTML 字符串时，
 * 旧实现按标签配对删除会一次吞掉 92.9% 的页面（443,192 → 435 字符，PRTS 实测）。
 *
 * @module dsh-prts/test/html-text
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DROP_CLASS_PREFIXES,
  cleanSnippet,
  decodeEntities,
  extractParserOutput,
  outlineFromText,
  reduceWikitext,
  removeElements,
  sliceSection,
  stripRawTextBlocks,
  stripTags,
  toText,
  truncateText,
} from '../lib/html-text.js';
import { PAGE_TEXT, PAGE_TEXT_FLAT } from './fixtures/fixtures.js';

const pageHtml = PAGE_TEXT.parse.text;

/** 默认配置下的归约。 */
function reduce(html) {
  return toText(html, { maxChars: 200_000 });
}

test('stripRawTextBlocks 摘掉原始文本元素的内容', () => {
  const html = '<p>前</p><script>var a = 1;</script><style>.a{color:red}</style><p>后</p>';
  const out = stripRawTextBlocks(html);
  assert.ok(!out.includes('var a = 1'), out);
  assert.ok(!out.includes('color:red'), out);
  assert.ok(out.includes('<p>前</p>') && out.includes('<p>后</p>'), out);
});

test('回归：脚本里含 HTML 字符串时，后面的正文必须还在', () => {
  const html = '<div class="mw-parser-output">'
    + '<script>var tpl = \'<div>\' + \'</div>\' + \'<span>\';</script>'
    + '<h2>属性</h2><p>生命上限 1480</p></div>';
  const out = reduce(html);
  assert.ok(out.text.includes('## 属性'), out.text);
  assert.ok(out.text.includes('生命上限 1480'), `脚本不该吞掉正文：${out.text}`);
});

test('回归：样式里含 </div> 字符串时同样不吞正文', () => {
  const html = '<div class="mw-parser-output">'
    + '<style>.x::after{content:"</div>"}</style>'
    + '<h2>干员信息</h2><p>代号 阿米娅</p></div>';
  const out = reduce(html);
  assert.ok(out.text.includes('干员信息'), out.text);
  assert.ok(out.text.includes('代号 阿米娅'), out.text);
});

test('未闭合的原始文本元素只摘开标签，内容保留（宁可留噪声不丢正文）', () => {
  const html = '<div class="mw-parser-output"><script>var a = 1;<p>后面的正文</p></div>';
  const out = reduce(html);
  assert.ok(out.text.includes('后面的正文'), out.text);
});

test('decodeEntities 处理命名、十进制与十六进制实体', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('it&#39;s'), "it's");
  assert.equal(decodeEntities('&#x2014;'), '—');
  assert.equal(decodeEntities('&nbsp;'), ' ');
  assert.equal(decodeEntities('&unknownent;'), '&unknownent;');
});

test('stripTags 去标签、解实体、压空白，并删掉脚本体与 CSS', () => {
  assert.equal(stripTags('看 <span class="searchmatch">能天使</span>  的信物'), '看 能天使 的信物');
  assert.equal(stripTags('a<script>var x=1;</script>b'), 'a b');
  assert.equal(stripTags('<style>.a{color:red}</style>正文'), '正文');
  assert.equal(stripTags('<!-- 注释 -->正文'), '正文');
});

test('extractParserOutput 只取正文容器，且不被脚本里的 </div> 带偏', () => {
  const html = '<div id="x">外面</div><div class="mw-parser-output"><script>var s = \'</div>\';</script>'
    + '<div>里面</div></div><div>后面</div>';
  assert.equal(extractParserOutput(html).includes('里面'), true);
  assert.equal(extractParserOutput(html).includes('后面'), false);
  assert.equal(extractParserOutput('<p>no wrapper</p>').trim(), '<p>no wrapper</p>');
});

test('removeElements 连子树一起删，并保留自闭合标签', () => {
  const html = '<p>keep<br>me</p><div class="navbox"><p>drop<i>nested</i></p></div><p>after</p>';
  const cleaned = removeElements(html, (_tag, attrs) => attrs.includes('navbox'));
  assert.ok(cleaned.includes('keep<br>me'));
  assert.ok(cleaned.includes('after'));
  assert.ok(!cleaned.includes('drop'));
  assert.ok(!cleaned.includes('nested'));
});

test('toText 保留结构：标题、表格、列表、粗体', () => {
  const { text } = reduce(pageHtml);
  assert.ok(text.includes('## 干员信息'), text.slice(0, 200));
  assert.ok(text.includes('| 代号 | 阿米娅 |'), text);
  assert.ok(text.includes('【表】精英化属性'), text);
  assert.ok(text.includes('- 情绪吸收'), text);
  assert.ok(text.includes('### 天赋'), text);
});

test('PRTS 数据形态：SMW 数据必须保留', () => {
  const { text } = reduce(pageHtml);
  assert.ok(text.includes('再部署时间'), `smw-field 是数据，不能丢：${text.slice(0, 400)}`);
  assert.ok(text.includes('70s'), text);
  assert.ok(text.includes('18→20'), text);
  assert.ok(text.includes('1480'), text);
  assert.ok(DEFAULT_DROP_CLASS_PREFIXES.length === 0, 'PRTS 默认不该按前缀丢任何 class');
});

test('PRTS 噪声：navbox / mdi / mc-tooltips / hide 丢掉', () => {
  const { text } = reduce(pageHtml);
  assert.ok(!text.includes('导航：干员列表'), text);
  assert.ok(!text.includes('提示文字'), text);
  assert.ok(!text.includes('隐藏数据'), text);
  assert.ok(!text.includes('悬浮提示正文不该出现'), text);
});

test('display:none 的页签内容必须保留', () => {
  const { text } = reduce(pageHtml);
  assert.ok(text.includes('未选中页签的正文（要保留）'), `页签靠 display:none 藏，不能丢：${text.slice(0, 300)}`);
});

test('默认不输出图片标记；keepImages 打开后输出', () => {
  const { text } = reduce(pageHtml);
  assert.ok(!text.includes('[图:'));
  const withImages = toText(pageHtml, { maxChars: 200_000, keepImages: true });
  assert.ok(withImages.text.includes('[图: 阿米娅头像.png]'));
});

test('目录与本地切片', () => {
  const reduced = reduce(pageHtml);
  assert.deepEqual(reduced.outline.sections.map((s) => s.title), ['干员信息', '属性', '天赋']);
  assert.deepEqual(reduced.outline.sections.map((s) => s.level), [2, 2, 3]);
  const first = sliceSection(reduced.text, reduced.outline, 1);
  assert.ok(first.startsWith('## 干员信息'), first);
  assert.ok(first.includes('| 代号 | 阿米娅 |'), first);
  assert.equal(sliceSection(reduced.text, reduced.outline, 99), undefined);
});

test('没有标题的页面：目录为空、整页即一段', () => {
  const reduced = reduce(PAGE_TEXT_FLAT.parse.text);
  assert.equal(reduced.outline.sections.length, 0);
  assert.equal(reduced.text, '只有一段正文。');
});

test('outlineFromText 不把带 # 的正文当标题', () => {
  const outline = outlineFromText('# 真标题\n#不是标题\n##   ');
  assert.deepEqual(outline.sections.map((s) => s.title), ['真标题']);
});

test('truncateText 在行边界截断并附续读提示', () => {
  const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}\n${'c'.repeat(30)}`;
  const out = truncateText(text, 40, { toolHint: 'prts_sections' });
  assert.equal(out.truncated, true);
  assert.ok(out.text.includes('已截断'));
  assert.ok(out.text.includes('prts_sections'));
  assert.ok(!out.text.includes('cccc'));
  assert.deepEqual(truncateText('短文本', 100), { text: '短文本', truncated: false, totalChars: 3 });
});

test('reduceWikitext 收敛模板、链接与强调', () => {
  assert.equal(reduceWikitext('{{材料|稀有度=5}} 龙门币'), '龙门币');
  assert.equal(reduceWikitext('[[能天使|查看干员]]'), '查看干员');
  assert.equal(reduceWikitext("'''粗''' ''斜''"), '粗 斜');
  assert.equal(reduceWikitext('外层 {{内层 {{嵌套}} }} 尾巴').includes('嵌套'), false);
});

test('cleanSnippet 归约 wikitext 形态的片段', () => {
  const raw = '|名称=<span class="searchmatch">能天使</span>的中坚信物 |用途=用于提升<span class="searchmatch">能天使</span>的潜能 '
    + '{{材料|稀有度=5}} [[能天使|查看干员]] 集满五颗的最佳老板奖章。';
  const out = cleanSnippet(raw);
  assert.ok(out.includes('能天使的中坚信物'), out);
  assert.ok(out.includes('查看干员'), out);
  assert.ok(!out.includes('searchmatch'), out);
  assert.ok(!out.includes('{{'), out);
  assert.ok(!out.includes('[['), out);
});

test('cleanSnippet 词表可覆盖、空输入安全、URL 不被切碎', () => {
  assert.equal(cleanSnippet('保留我', { phrases: [], sentences: [] }), '保留我');
  assert.equal(cleanSnippet('', {}), '');
  const url = '接口在 https://prts.wiki/api.php?action=query&list=search 这里。';
  assert.equal(cleanSnippet(url), url);
  assert.equal(cleanSnippet('样板句。真内容。', { sentences: ['样板句'] }), '真内容。');
});
