/**
 * 数据层离线测试：站点上下文、URL 构造契约、响应映射、命名空间/分类的本地化处理。
 *
 * @module dsh-prts/test/mediawiki
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NAMESPACE_LABELS,
  allPagesUrl,
  backlinksUrl,
  buildNamespaceLabels,
  categoryMembersUrl,
  categoryTitle,
  linksUrl,
  mapAllPages,
  mapApiError,
  mapBacklinks,
  mapCategoryMembers,
  mapLinks,
  mapPageInfo,
  mapPageText,
  mapPrefixSearch,
  mapRecentChanges,
  mapSearch,
  mapSiteInfo,
  mapWikitext,
  namespaceLabel,
  pageInfoUrl,
  pageTextUrl,
  prefixSearchUrl,
  recentChangesUrl,
  searchUrl,
  siteInfoUrl,
  stripCategoryPrefix,
  wikitextUrl,
} from '../lib/mediawiki.js';
import { DEFAULT_SITE, createSite, normalizeApiPath, normalizeArticlePath, pageUrl } from '../lib/sites.js';
import {
  BACKLINKS, CATEGORY_MEMBERS, LINKS, PAGE_INFO, PAGE_INFO_MISSING,
  PREFIX_SEARCH, ALL_PAGES, RECENT_CHANGES, SEARCH, SITEINFO,
} from './fixtures/fixtures.js';

const site = createSite({ wikiBaseUrl: 'https://prts.wiki', apiPath: '/api.php', articlePath: '/w/$1' });

/** 取出查询参数。 */
function params(url) {
  return new URL(url).searchParams;
}

test('createSite：默认站点、articlePath 显式配置与回退', () => {
  assert.equal(DEFAULT_SITE.baseUrl, 'https://prts.wiki');
  const dflt = createSite();
  assert.equal(dflt.baseUrl, 'https://prts.wiki');
  assert.equal(dflt.apiPath, '/api.php');
  assert.equal(dflt.articlePath, '/w/$1');
  assert.equal(dflt.origin, 'https://prts.wiki');

  // articlePath 必须显式生效：它推不出来（scriptpath 为空、文章在 /w/）
  assert.equal(createSite({ articlePath: '/w/$1' }).articlePath, '/w/$1');
  // 缺 $1 时回退到由 baseUrl 推导
  assert.equal(createSite({ articlePath: '/wiki' }).articlePath, '/$1');
  assert.equal(createSite({ wikiBaseUrl: 'not-a-url' }).baseUrl, 'https://prts.wiki');
  assert.equal(createSite({ apiPath: 'api.php' }).apiPath, '/api.php');
  assert.equal(normalizeApiPath(''), '/api.php');
  assert.equal(normalizeArticlePath('/w/$1', 'https://prts.wiki'), '/w/$1');
});

test('apiUrl：固定 format/formatversion，丢掉 undefined/null 但保留 0', () => {
  const info = params(siteInfoUrl(site));
  assert.equal(info.get('format'), 'json');
  assert.equal(info.get('formatversion'), '2');
  assert.equal(info.get('siprop'), 'general|statistics|namespaces|namespacealiases');

  const url = new URL(siteInfoUrl(site));
  assert.equal(url.origin, 'https://prts.wiki');
  assert.equal(url.pathname, '/api.php', '接口在根路径，不是 /w/api.php');
});

test('pageUrl：PRTS 的 /w/ 文章路径 + 按段编码', () => {
  assert.equal(pageUrl(site, '阿米娅'), `https://prts.wiki/w/${encodeURIComponent('阿米娅')}`);
  assert.equal(pageUrl(site, '龙门币'), `https://prts.wiki/w/${encodeURIComponent('龙门币')}`);
  // 子页 + 括号：/ 必须保留，不能被写成 %2F
  const sub = pageUrl(site, '阿米娅(医疗)/语音记录');
  assert.ok(sub.startsWith('https://prts.wiki/w/'), sub);
  assert.ok(sub.includes('/%E8%AF%AD%E9%9F%B3%E8%AE%B0%E5%BD%95'), sub);
  assert.ok(!sub.includes('%2F'), sub);
  assert.equal(pageUrl(site, 'PRTS:首页'), 'https://prts.wiki/w/PRTS:%E9%A6%96%E9%A1%B5', '冒号保持字面量');
  assert.equal(pageUrl(site, 'A B'), 'https://prts.wiki/w/A_B');
});

test('categoryTitle / stripCategoryPrefix：本地化分类名双向可用', () => {
  assert.equal(categoryTitle('干员'), 'Category:干员');
  assert.equal(categoryTitle('分类:干员'), 'Category:干员');
  assert.equal(categoryTitle('Category:干员'), 'Category:干员');
  assert.equal(stripCategoryPrefix('分类:干员'), '干员');
  assert.equal(stripCategoryPrefix('模板:干员'), '模板:干员');
});

test('namespaceLabel：运行期表优先，PRTS 的 4/274 都能显示', () => {
  assert.equal(namespaceLabel(4, { 4: 'PRTS' }), 'PRTS');
  assert.equal(namespaceLabel(274, { 274: '微件' }), '微件');
  assert.equal(namespaceLabel(14), '分类');
  assert.equal(namespaceLabel(999), 'ns999');
  assert.equal(namespaceLabel(0), '');
  assert.equal(DEFAULT_NAMESPACE_LABELS[274], '微件');
});

test('buildNamespaceLabels 兼容「以 id 为键的对象」与数组两种形状', () => {
  assert.equal(buildNamespaceLabels(SITEINFO)['4'], 'PRTS');
  assert.equal(buildNamespaceLabels(SITEINFO)['274'], '微件');
  const asArray = { query: { namespaces: [{ id: 14, name: '分类' }, { id: '0', name: '' }] } };
  assert.deepEqual(buildNamespaceLabels(asArray), { 14: '分类', 0: '' });
  assert.deepEqual(buildNamespaceLabels({}), {});
});

test('mapSiteInfo：站点身份、统计、命名空间表与分类别名', () => {
  const info = mapSiteInfo(SITEINFO);
  assert.equal(info.sitename, 'PRTS');
  assert.equal(info.generator, 'MediaWiki 1.43.9');
  assert.equal(info.lang, 'zh-cn');
  assert.equal(info.articlepath, '/w/$1');
  assert.equal(info.statistics.pages, 80893);
  assert.equal(namespaceLabel(4, info.labels), 'PRTS');
  assert.ok(info.categoryNames.includes('分类'));
  assert.ok(info.categoryNames.includes('Category'));
});

test('各端点 URL 契约', () => {
  const search = params(searchUrl(site, { query: '能天使', limit: 10, offset: 20, namespace: '*' }));
  assert.equal(search.get('list'), 'search');
  assert.equal(search.get('srsearch'), '能天使');
  assert.equal(search.get('sroffset'), '20');
  assert.equal(search.get('srnamespace'), '*');
  assert.ok(String(search.get('srprop')).includes('snippet'));

  const prefix = params(prefixSearchUrl(site, { query: '阿米娅', limit: 5, namespace: '*' }));
  assert.equal(prefix.get('list'), 'prefixsearch');
  assert.equal(prefix.get('psnamespace'), '*');

  const all = params(allPagesUrl(site, { prefix: '龙门', limit: 5, namespace: 0 }));
  assert.equal(all.get('list'), 'allpages');
  assert.equal(all.get('apprefix'), '龙门');

  const text = params(pageTextUrl(site, { title: '阿米娅' }));
  assert.equal(text.get('action'), 'parse');
  assert.equal(text.get('prop'), 'text|revid');
  assert.equal(text.get('redirects'), '1');
  assert.equal(text.has('section'), false, '分节在本地做，不传 section');

  assert.equal(params(wikitextUrl(site, { title: '龙门币' })).get('prop'), 'wikitext|revid');

  const info = params(pageInfoUrl(site, { title: '阿米娅', categoryLimit: 50 }));
  assert.equal(info.get('prop'), 'info|pageprops|categories|revisions');
  assert.equal(info.get('inprop'), 'url|displaytitle');
  assert.equal(info.get('rvlimit'), '1');

  assert.equal(params(linksUrl(site, { title: '阿米娅', limit: 30 })).get('prop'), 'links');
  assert.equal(params(backlinksUrl(site, { title: '阿米娅', limit: 30 })).get('list'), 'backlinks');
  assert.equal(params(categoryMembersUrl(site, { category: '分类:干员', limit: 30, type: 'page' })).get('cmtitle'), 'Category:干员');

  const now = new Date('2026-10-02T12:00:00Z');
  const recent = params(recentChangesUrl(site, { limit: 20, days: 3, now }));
  assert.equal(recent.get('rcstart'), '2026-10-02T12:00:00.000Z');
  assert.equal(recent.get('rcend'), '2026-09-29T12:00:00.000Z');
});

test('mapSearch：wikitext 形态的片段也能归一', () => {
  const mapped = mapSearch(SEARCH);
  assert.equal(mapped.totalHits, 10);
  assert.equal(mapped.offset, 2);
  assert.equal(mapped.items.length, 2);
  assert.ok(mapped.items[0].snippet.includes('searchmatch'));
  assert.equal(mapped.items[1].ns, 10);
});

test('mapPrefixSearch / mapAllPages / mapPageText / mapWikitext', () => {
  assert.deepEqual(mapPrefixSearch(PREFIX_SEARCH).items.map((i) => i.title), ['阿米娅', '阿米娅(医疗)', '阿米娅(医疗)/语音记录']);
  assert.deepEqual(mapAllPages(ALL_PAGES).items.map((i) => i.title), ['龙门币', '龙门市区']);
  assert.deepEqual(mapPrefixSearch({}).items, []);
  assert.deepEqual(mapAllPages(undefined).items, []);

  const page = mapPageText({ parse: { title: '阿米娅', pageid: 1751, revid: 404892, text: '<p>x</p>' } });
  assert.deepEqual([page.title, page.pageid, page.revid, page.html], ['阿米娅', 1751, 404892, '<p>x</p>']);
  assert.equal(mapWikitext({ parse: { title: '龙门币', wikitext: '{{材料}}' } }).content, '{{材料}}');
  assert.equal(mapWikitext({}).content, '');
});

test('mapPageInfo：剥掉本地化分类前缀、给出最后编辑与重定向来源', () => {
  const info = mapPageInfo(PAGE_INFO, { categoryNames: ['分类', 'Category'] });
  assert.equal(info.found, true);
  assert.equal(info.title, '阿米娅(医疗)/语音记录');
  assert.deepEqual(info.categories, ['干员', '对原文有修正的页面']);
  assert.deepEqual(info.redirectFrom, ['阿米娅(医疗)/语音']);
  assert.equal(info.lastEdit.user, 'BotPtilopsis');
  assert.equal(info.lastEdit.comment, '机器人：更新语音');
  assert.equal(info.length, 29359);
  assert.ok(String(info.fullurl).startsWith('https://prts.wiki/w/'));

  const missing = mapPageInfo(PAGE_INFO_MISSING);
  assert.equal(missing.found, false);
  assert.equal(missing.missing, true);
});

test('mapLinks / mapBacklinks / mapCategoryMembers / mapRecentChanges', () => {
  const links = mapLinks(LINKS, '阿米娅');
  assert.deepEqual(links.links.map((l) => l.title), ['12F', '模板:干员']);
  const backlinks = mapBacklinks(BACKLINKS);
  assert.equal(backlinks[1].title, '模板:关卡报酬/doc');
  assert.equal(backlinks[2].redirect, true);
  const members = mapCategoryMembers(CATEGORY_MEMBERS);
  assert.deepEqual(members.map((m) => m.type), ['page', 'subcat', 'file']);
  const recent = mapRecentChanges(RECENT_CHANGES);
  assert.equal(recent[0].ns, 274);
  assert.equal(recent[1].type, 'new');
  assert.equal(recent[0].newlen - recent[0].oldlen, 145);
});

test('mapApiError 只在真有 error 时返回对象', () => {
  assert.deepEqual(mapApiError({ error: { code: 'badvalue', info: 'x' } }), { code: 'badvalue', info: 'x' });
  assert.equal(mapApiError({}), undefined);
  assert.equal(mapApiError(undefined), undefined);
});
