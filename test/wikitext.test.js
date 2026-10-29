/**
 * `lib/wikitext.js` 的离线单元测试：模板解析、嵌套、注释、链接、`{{!}}`、多行与上限截断。
 *
 * 纯函数、不联网；夹具是手工构造的最小 wikitext，另有一条真实干员页的裁剪版
 * （`test/fixtures/fixtures.js` 的 `OPERATOR_WIKITEXT_ANGEL` 等）在 operator 测试里覆盖。
 *
 * @module dsh-prts/test/wikitext
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findTemplate,
  findTemplates,
  normalizeTemplateName,
  parseTemplates,
  sameTemplateName,
  WIKITEXT_LIMITS,
} from '../lib/wikitext.js';

test('normalizeTemplateName: 去空白与 模板:/Template:/subst: 前缀', () => {
  assert.equal(normalizeTemplateName('  CharinfoV2  '), 'CharinfoV2');
  assert.equal(normalizeTemplateName('模板:颜色'), '颜色');
  assert.equal(normalizeTemplateName('Template:Color'), 'Color');
  assert.equal(normalizeTemplateName('subst:模板:颜色'), '颜色');
  assert.equal(normalizeTemplateName(undefined), '');
  assert.equal(sameTemplateName('模板:CharinfoV2', 'charinfov2'), true);
  assert.equal(sameTemplateName('a', 'b'), false);
});

test('parseTemplates: 命名参数 + 匿名参数 + 行号 + depth', () => {
  const parsed = parseTemplates('leading\n{{CharinfoV2\n|稀有度=5\n|职业=狙击\n|输出\n}}');
  assert.equal(parsed.templates.length, 1);
  const [template] = parsed.templates;
  assert.equal(template.name, 'CharinfoV2');
  assert.equal(template.depth, 1);
  assert.equal(template.line, 2);
  assert.deepEqual(template.params, { 稀有度: '5', 职业: '狙击' });
  assert.deepEqual(template.positional, ['输出']);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.truncatedReasons, []);
});

test('parseTemplates: 重复命名参数后者覆盖，空键进匿名列表', () => {
  const parsed = parseTemplates('{{t|a=1|a=2|=x|plain}}');
  const [template] = parsed.templates;
  assert.equal(template.params.a, '2');
  assert.deepEqual(template.positional, ['x', 'plain']);
});

test('parseTemplates: 嵌套模板（父参数值里保留原文，嵌套单独记录）', () => {
  const parsed = parseTemplates('{{outer|a={{inner|p|q}}|b=2}}');
  const outer = findTemplate(parsed.templates, 'outer');
  const inner = findTemplate(parsed.templates, 'inner');
  assert.equal(outer.depth, 1);
  assert.equal(inner.depth, 2);
  assert.equal(outer.params.a, '{{inner|p|q}}');
  assert.deepEqual(inner.positional, ['p', 'q']);
  assert.equal(outer.params.b, '2');
  // 默认按文档顺序输出：先顶层，再嵌套。
  assert.deepEqual(parsed.templates.map((item) => item.name), ['outer', 'inner']);
});

test('parseTemplates: 注释整段跳过（正文/参数里的花括号不算模板）', () => {
  const parsed = parseTemplates('<!--\n{{fake}}\n-->\n{{a|x=1<!-- {{fake2}} -->|y=2}}');
  assert.deepEqual(parsed.templates.map((item) => item.name), ['a']);
  const [template] = parsed.templates;
  assert.equal(template.line, 4);
  assert.deepEqual(template.params, { x: '1', y: '2' });
});

test('parseTemplates: [[链接|标签]] 里的 | 与 = 不切参数', () => {
  const parsed = parseTemplates('{{a|link=[[4-10|标题]]|[[x|y=z]]}}');
  const [template] = parsed.templates;
  assert.equal(template.params.link, '[[4-10|标题]]');
  assert.deepEqual(template.positional, ['[[x|y=z]]']);
});

test('parseTemplates: {{!}} 在参数值里还原成字面管道符', () => {
  const parsed = parseTemplates('{{outer|x={{!}}y}}');
  const outer = findTemplate(parsed.templates, 'outer');
  assert.equal(outer.params.x, '|y');
  assert.ok(parsed.templates.some((item) => item.name === '!'), '嵌套的 {{!}} 也应出现在模板表里');
});

test('parseTemplates: 多行参数值保留内部换行，只裁首尾空白', () => {
  const parsed = parseTemplates('{{干员获得方式\n|获得方式=主线剧情\n|覆盖=第一行\n第二行\n}}');
  const template = findTemplate(parsed.templates, '干员获得方式');
  assert.equal(template.params['获得方式'], '主线剧情');
  assert.equal(template.params['覆盖'], '第一行\n第二行');
});

test('parseTemplates: 未闭合模板不输出，并记录 unclosed-template', () => {
  const parsed = parseTemplates('{{a|x=1');
  assert.deepEqual(parsed.templates, []);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.truncatedReasons.includes('unclosed-template'));
});

test('parseTemplates: 上限截断（input / templates / params / value）', () => {
  const tooMany = parseTemplates('{{a}}{{b}}{{c}}', { maxTemplates: 2 });
  assert.equal(tooMany.templates.length, 2);
  assert.ok(tooMany.truncatedReasons.includes('templates'));

  const manyParams = parseTemplates('{{a|1|2|3}}', { maxParams: 2 });
  assert.deepEqual(manyParams.templates[0].positional, ['1', '2']);
  assert.ok(manyParams.truncatedReasons.includes('params'));

  const longValue = parseTemplates('{{a|x=123456789012345678901234567890}}', { maxValueChars: 16 });
  assert.match(longValue.templates[0].params.x, /^1234567890123456…（已截断）$/);
  assert.ok(longValue.truncatedReasons.includes('value'));

  const longInput = parseTemplates(`{{a}}${'x'.repeat(2000)}`, { maxInputChars: 1000 });
  assert.ok(longInput.truncatedReasons.includes('input'));
  assert.equal(longInput.length, 2005, 'length 是原始输入长度');
});

test('findTemplates / findTemplate: 顶层优先、名字大小写与前缀不敏感', () => {
  const parsed = parseTemplates('{{A}}{{outer|{{A|k=v}}}}');
  const matched = findTemplates(parsed.templates, ['模板:A']);
  assert.equal(matched.length, 2);
  assert.equal(matched[0].depth, 1);
  assert.equal(matched[1].depth, 2);
  assert.equal(findTemplate(parsed.templates, ['a']).depth, 1);
  assert.equal(findTemplate(parsed.templates, ['nope']), null);
});

test('parseTemplates: 空输入 / 非字符串输入都不抛', () => {
  assert.deepEqual(parseTemplates('').templates, []);
  assert.deepEqual(parseTemplates(undefined).templates, []);
  assert.deepEqual(parseTemplates(null).templates, []);
  assert.equal(WIKITEXT_LIMITS.maxTemplates > 0, true);
});
