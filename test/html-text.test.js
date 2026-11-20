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
  DEFAULT_DROP_CLASSES,
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
import { PAGE_TEXT, PAGE_TEXT_EMPHASIS, PAGE_TEXT_FLAT } from './fixtures/fixtures.js';

const pageHtml = PAGE_TEXT.parse.text;

/** 默认配置下的归约（可覆盖选项）。 */
function reduce(html, options = {}) {
  return toText(html, { maxChars: 200_000, ...options });
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

test('强调：b/i 正确配对、同类型嵌套只留一层、空强调不留残星', () => {
  assert.equal(reduce('<p><b>粗体</b>普通</p>').text, '**粗体**普通');
  assert.equal(reduce('<p><i>斜体</i>普通</p>').text, '*斜体*普通');
  assert.equal(reduce('<p><b>外<i>内</i></b></p>').text, '**外*内***');
  assert.equal(reduce('<p><b><b>双层</b></b></p>').text, '**双层**', '同类型嵌套不该叠成 ****');
  assert.equal(reduce('<p>前<b></b>后<i></i>尾</p>').text, '前后尾', '空强调整对抹掉');
  const withSpace = reduce('<p>前<b></b>后<i> </i>尾</p>').text;
  assert.ok(!withSpace.includes('*'), withSpace);
});

test('回归：<big>/<img> 不能被当成 <b>/<i> 的开标签（真站强调错配的根因）', () => {
  // 阿米娅页实测 8 个 <big>、183 个 <img>：旧实现写 `<(b|strong)[^>]*>`，
  // `<big>` 会被当成 <b>、`<img>` 会被当成 <i>，与后面的闭标签错配，
  // 于是正文里散落 `**`/`*`（真站复现 37 行带星号）。
  const { text } = reduce('<p><big>战术咏唱·γ型</big></p><p><img alt="x">普通文本</p>'
    + '<p>如需了解<b>所有干员的上线时间</b>，您也可以查阅<a href="#">干员上线时间一览</a>页面。</p>');
  assert.equal(
    text,
    '战术咏唱·γ型\n\n普通文本\n\n如需了解**所有干员的上线时间**，您也可以查阅干员上线时间一览页面。',
    text,
  );
  assert.equal((text.match(/\*/g) || []).length, 4, `只该有两对粗体标记：${text}`);
});

test('强调：只剩图片的强调、跨段落的强调都不留孤立标记', () => {
  assert.equal(reduce('<p><b><img alt="x"></b></p>').text, '', '图片被丢掉后强调内容为空');
  assert.equal(reduce('<p><b><img alt="图"></b></p>', { keepImages: true }).text, '**[图: 图]**');
  const across = reduce('<p><b>开头<div>中间</div>结尾</b></p>').text;
  assert.equal(across.includes('*'), false, `跨段强调不该输出标记：${across}`);
});

test('定义列表：dt 不再叠两层粗体，dd 仍是独立行', () => {
  const { text } = reduce('<dl><dt>属性</dt><dd>值</dd><dt><b>已加粗的术语</b></dt><dd>说明</dd></dl>');
  assert.ok(text.includes('- 属性'), text);
  assert.ok(text.includes(': 值'), text);
  assert.ok(text.includes('- **已加粗的术语**'), text);
  assert.ok(!text.includes('****'), text);
});

test('表格：单元格里的 div/p/list 不换行，整行归约成 | a | b |', () => {
  assert.equal(
    reduce('<table><tr><td><div>代号</div></td><td><p>阿米娅</p></td></tr></table>').text,
    '| 代号 | 阿米娅 |',
  );
  assert.equal(
    reduce('<table><tr><td><div class="poem"><ul><li>可对空。</li></ul></div></td><td><b>说明</b></td></tr></table>').text,
    '| 可对空。 | 说明 |',
  );
  const multi = reduce('<table><caption>精英化属性</caption><tr><th>生命上限</th>'
    + '<td><div>699</div></td><td><p>958</p></td></tr></table>').text;
  assert.ok(multi.includes('【表】精英化属性'), multi);
  assert.ok(multi.split('\n').includes('| 生命上限 | 699 | 958 |'), multi);
});

test('真实形态（阿米娅风格）：表格/列表里的 <b> 不残留、不串行', () => {
  const { text } = reduce('<h2>天赋</h2><ul><li><b>情绪吸收</b>：成功造成伤害后回复3点技力</li></ul>'
    + '<table class="wikitable"><tr><th>潜能</th><td><b>部署费用-1</b></td></tr></table>');
  assert.ok(text.includes('- **情绪吸收**：成功造成伤害后回复3点技力'), text);
  assert.ok(text.split('\n').includes('| 潜能 | 部署费用-1 |'), text);
  assert.equal((text.match(/\*\*/g) || []).length, 2, text);
});

test('父节包含子节正文：endLine 在同级或更高级标题处收束', () => {
  const text = '# A\na\n## B\nb\n### B1\nb1\n## C\nc';
  const outline = outlineFromText(text);
  assert.equal(outline.sections[0].childSections, 3);
  const parent = sliceSection(text, outline, 1);
  assert.ok(parent.includes('## B') && parent.includes('b1') && parent.includes('## C'), parent);
  assert.equal(sliceSection(text, outline, 2), '## B\nb\n### B1\nb1');
  assert.equal(sliceSection(text, outline, 3), '### B1\nb1');
  assert.equal(sliceSection(text, outline, 4), '## C\nc');
  // 目录字符数就是切片长度，不再误导
  assert.equal(parent.length, text.length);
  assert.equal(outline.sections[1].endLine, outline.sections[3].startLine - 1);
});

test('truncateText 可以覆盖续读提示（读某一节时不再让人去看目录）', () => {
  const text = `${'a'.repeat(50)}\n${'b'.repeat(50)}`;
  const out = truncateText(text, 40, { hint: '提高 maxChars（上限 60000）。' });
  assert.equal(out.truncated, true);
  assert.ok(out.text.includes('已截断'), out.text);
  assert.ok(out.text.includes('提高 maxChars'), out.text);
  assert.ok(!out.text.includes('prts_sections'), out.text);
});

test('真实片段夹具（阿米娅/能天使风格）：表格/列表里的 <b> 不残留、单元格不拆行', () => {
  const { text } = reduce(PAGE_TEXT_EMPHASIS.parse.text);
  assert.ok(text.includes('- **情绪吸收**：成功造成伤害后额外回复3点技力'), text);
  assert.ok(text.includes('- *精神爆发*：攻击力提升'), text);
  assert.ok(text.includes('| 潜能 | 部署费用-1 |'), text);
  assert.ok(text.includes('| 生命上限 | 699 | 958 |'), text);
  // <big>/<img> 不该被当成强调
  assert.ok(text.includes('战术咏唱·γ型'), text);
  assert.ok(!text.includes('*战术咏唱'), text);
  const stars = (text.match(/\*/g) || []).length;
  assert.equal(stars % 2, 0, `粗体标记应当成对：${text}`);
  assert.ok(text.includes('如需了解**所有干员的上线时间**，您也可以查阅干员上线时间一览页面。'), text);
});

test('干员页立绘/看板控件默认丢掉（2026-11-20 真站实测 class）', () => {
  for (const name of [
    'control-btns', 'control-btn-flex', 'control-btn-text', 'watchimg-btn', 'watchimg-btn-m',
    'download-btn', 'voice-btn', 'img-switch-btn', 'dyn-btn', 'charpainter', 'painter-wrapper',
    'charvoice-wrapper', 'charvoice-title', 'charcv-img', 'charcv-text-flex', 'chardyn-text', 'chardyn-collapse',
  ]) {
    assert.ok(DEFAULT_DROP_CLASSES.includes(name), `缺少 ${name}`);
  }
  const { text } = reduce('<div class="control-btns"><div class="control-btn-text">全屏查看</div>'
    + '<div class="watchimg-btn">看图模式</div></div>'
    + '<div class="charpainter"><span class="painter-left">绘制</span></div>'
    + '<div class="charvoice-wrapper"><div class="charvoice-title">VOICE</div></div>'
    + '<div class="chardyn-text">动作切换</div><p>正文</p>');
  assert.equal(text, '正文');
});
