/**
 * 测试夹具：形状取自 2026-10-02 对 `prts.wiki` 的真实响应（已裁剪体积）。
 *
 * 刻意用手写但保真的对象字面量：
 * - `namespaces` 在 MW 1.43 上是**以 id 为键的对象**（实测），`4=PRTS`、`274=微件`；
 * - 检索片段是 **wikitext 原文**（该站没有 CirrusSearch）；
 * - 页面 HTML 里塞进了那条真实踩过的坑：**内联脚本含 HTML 字符串**
 *   （旧实现按标签配对删除，一次吞掉 92.9% 的页面）。
 *
 * @module dsh-prts/test/fixtures
 */

/** siteinfo：站点名、MW 版本、统计、命名空间与别名。 */
export const SITEINFO = {
  batchcomplete: '',
  query: {
    general: {
      mainpage: '首页',
      base: 'https://prts.wiki/w/%E9%A6%96%E9%A1%B5',
      sitename: 'PRTS',
      generator: 'MediaWiki 1.43.9',
      articlepath: '/w/$1',
      scriptpath: '',
      server: 'https://prts.wiki',
      lang: 'zh-cn',
      writeapi: false,
      timezone: 'Asia/Shanghai',
    },
    statistics: { pages: 80893, articles: 41234, edits: 1900000, images: 51234, users: 123456, activeusers: 321 },
    namespaces: {
      0: { id: 0, case: 'first-letter', name: '', content: true },
      2: { id: 2, case: 'first-letter', name: '用户', canonical: 'User' },
      4: { id: 4, case: 'first-letter', name: 'PRTS', canonical: 'Project' },
      6: { id: 6, case: 'first-letter', name: '文件', canonical: 'File' },
      10: { id: 10, case: 'first-letter', name: '模板', canonical: 'Template' },
      14: { id: 14, case: 'first-letter', name: '分类', canonical: 'Category' },
      274: { id: 274, case: 'first-letter', name: '微件', canonical: 'Widget' },
      828: { id: 828, case: 'first-letter', name: '模块', canonical: 'Module' },
      '-1': { id: -1, case: 'first-letter', name: '特殊', canonical: 'Special' },
    },
    namespacealiases: [{ id: 14, alias: 'Category' }, { id: -2, alias: '媒体文件' }],
  },
};

/** 检索命中：片段是 wikitext 原文（含 `searchmatch` 高亮与模板/链接标记）。 */
export const SEARCH = {
  batchcomplete: '',
  continue: { sroffset: 2, continue: '-||' },
  query: {
    searchinfo: { totalhits: 10 },
    search: [
      {
        ns: 0,
        title: '能天使的中坚信物',
        pageid: 50001,
        size: 612,
        wordcount: 40,
        timestamp: '2025-11-02T08:00:00Z',
        snippet: '|名称=<span class="searchmatch">能天使</span>的中坚信物 |用途=用于提升<span class="searchmatch">能天使</span>的潜能 '
          + '{{材料|稀有度=5}} [[能天使|查看干员]] 集满五颗的最佳老板奖章。',
      },
      {
        ns: 10,
        title: '模板:材料',
        pageid: 700,
        size: 3200,
        wordcount: 150,
        snippet: '{{#invoke:Material|row}} 材料行模板',
      },
    ],
  },
};

/** 无命中的检索。 */
export const SEARCH_EMPTY = { batchcomplete: '', query: { searchinfo: { totalhits: 0 }, search: [] } };

/** 检索参数被拒。 */
export const API_ERROR_BADVALUE = {
  error: { code: 'badvalue', info: 'Unrecognized value for parameter "srlimit".', docref: 'See https://prts.wiki/api.php for API usage.' },
};

/** 前缀候选。 */
export const PREFIX_SEARCH = {
  batchcomplete: true,
  continue: { psoffset: 3, continue: '-||' },
  query: {
    prefixsearch: [
      { ns: 0, title: '阿米娅', pageid: 1751 },
      { ns: 0, title: '阿米娅(医疗)', pageid: 67010 },
      { ns: 0, title: '阿米娅(医疗)/语音记录', pageid: 67011 },
    ],
  },
};

/** 前缀枚举兜底。 */
export const ALL_PAGES = {
  batchcomplete: true,
  continue: { apcontinue: '龙门币', continue: '-||' },
  query: { allpages: [{ pageid: 3001, ns: 0, title: '龙门币' }, { pageid: 3002, ns: 0, title: '龙门市区' }] },
};

export const PREFIX_SEARCH_EMPTY = { batchcomplete: true, query: { prefixsearch: [] } };
export const ALL_PAGES_EMPTY = { batchcomplete: true, query: { allpages: [] } };

/** `prop=info|pageprops|categories|revisions` 响应。 */
export const PAGE_INFO = {
  batchcomplete: '',
  query: {
    redirects: [{ from: '阿米娅(医疗)/语音', to: '阿米娅(医疗)/语音记录' }],
    pages: [
      {
        pageid: 1751,
        ns: 0,
        title: '阿米娅(医疗)/语音记录',
        touched: '2026-09-20T10:00:00Z',
        lastrevid: 404892,
        length: 29359,
        fullurl: 'https://prts.wiki/w/%E9%98%BF%E7%B1%B3%E5%A8%85(%E5%8C%BB%E7%96%97)/%E8%AF%AD%E9%9F%B3%E8%AE%B0%E5%BD%95',
        displaytitle: '阿米娅(医疗)/语音记录',
        pageprops: { displaytitle: '阿米娅(医疗)/语音记录' },
        categories: [{ ns: 14, title: '分类:干员' }, { ns: 14, title: '分类:对原文有修正的页面' }],
        revisions: [{ revid: 404892, parentid: 404800, user: 'BotPtilopsis', timestamp: '2026-09-20T10:00:00Z', comment: '机器人：更新语音' }],
      },
    ],
  },
};

/** 页面不存在的 `prop=info`。 */
export const PAGE_INFO_MISSING = {
  batchcomplete: '',
  query: {
    pages: [
      {
        ns: 0,
        title: '这个页面肯定不存在xyz123',
        missing: true,
        contentmodel: 'wikitext',
        pagelanguage: 'zh-cn',
        fullurl: 'https://prts.wiki/w/%E8%BF%99%E4%B8%AA%E9%A1%B5%E9%9D%A2%E8%82%AF%E5%AE%9A%E4%B8%8D%E5%AD%98%E5%9C%A8xyz123',
      },
    ],
  },
};

/** 页面不存在的 parse 错误。 */
export const API_ERROR_MISSINGTITLE = {
  error: { code: 'missingtitle', info: "The page you specified doesn't exist.", docref: 'See https://prts.wiki/api.php for API usage.' },
};

/** wikitext 源码（`action=parse&prop=wikitext`）。 */
export const WIKITEXT = {
  parse: { title: '龙门币', pageid: 3001, revid: 404892, wikitext: '{{材料\n|名称=龙门币\n|用途=通用货币\n}}' },
};

/**
 * 干员页的裁剪版（`阿米娅`）——刻意包含三类关键形态：
 *
 * 1. **内联脚本里含 HTML 字符串**（`'<div class="x">'`）：这是那个吞掉 92.9% 页面的坑，
 *    回归用例盯着它；
 * 2. **TemplateStyles 的 `<style>`**（真站占 8%）与 `navbox`、`mdi`、`mc-tooltips`、`hide`；
 * 3. **`display:none` 的两种含义**：SMW 悬浮框（该丢）与 `resp-tab-content` 页签（该留），
 *    以及 SMW 数据本身（`smw-row`/`smw-field`/`smw-value`，绝不能丢）。
 */
export const PAGE_TEXT = {
  parse: {
    title: '阿米娅',
    pageid: 1751,
    revid: 404892,
    text: [
      '<div class="mw-content-ltr mw-parser-output" lang="zh-Hans-CN" dir="ltr">',
      '<style data-mw-deduplicate="TemplateStyles:r429561">.mw-parser-output .navbox{display:none}</style>',
      '<script>(function(){var tpl = \'<div class="x">\' + \'</div>\' + \'<span class="y">\';document.write(tpl);})();</script>',
      '<div class="navbox"><table><tr><td>导航：干员列表</td></tr></table></div>',
      '<div style="display:none"><span class="smw-highlighter">悬浮提示正文不该出现</span></div>',
      '<div class="resp-tab-content" style="display:none"><p>未选中页签的正文（要保留）</p></div>',
      '<h2>干员信息</h2>',
      '<table class="wikitable"><tr><th>代号</th><td>阿米娅</td></tr><tr><th>职业</th><td>术师</td></tr></table>',
      '<h2>属性</h2>',
      '<table><caption>精英化属性</caption>',
      '<tr><th>生命上限</th><td>699</td><td>958</td><td>1198</td><td>1480</td></tr>',
      '<tr><th>攻击</th><td>276</td><td>390</td><td>514</td><td>612</td></tr>',
      '<tr><th>防御</th><td>48</td><td>81</td><td>110</td><td>121</td></tr>',
      '<tr><th>法术抗性</th><td>10</td><td>10</td><td>15</td><td>20</td></tr>',
      '</table>',
      '<div class="smw-row"><span class="smw-field">再部署时间</span><span class="smw-value">70s</span></div>',
      '<div class="smw-row"><span class="smw-field">部署费用</span><span class="smw-value">18→20</span></div>',
      '<span class="mdi mdi-plus">+</span><span class="mc-tooltips">提示文字</span>',
      '<h3>天赋</h3><ul><li>情绪吸收</li><li>精神爆发</li></ul>',
      '<img alt="阿米娅头像.png"><img src="/images/x.png">',
      '<div class="hide">隐藏数据</div>',
      '</div>',
    ].join(''),
  },
};

/** 完全没有标题的页面。 */
export const PAGE_TEXT_FLAT = {
  parse: { title: '某数据页', pageid: 9001, revid: 1, text: '<div class="mw-parser-output"><div>只有一段正文。</div></div>' },
};

/** 出链。 */
export const LINKS = {
  batchcomplete: '',
  continue: { plcontinue: '1751|0|12F', continue: '||' },
  query: {
    pages: [
      {
        pageid: 1751,
        ns: 0,
        title: '阿米娅',
        links: [{ ns: 0, title: '12F' }, { ns: 10, title: '模板:干员' }],
      },
    ],
  },
};

/** 反向链接（含模板子页）。 */
export const BACKLINKS = {
  batchcomplete: '',
  continue: { lhcontinue: '900', continue: '||' },
  query: {
    backlinks: [
      { pageid: 900, ns: 10, title: '模板:关卡报酬', redirect: false },
      { pageid: 901, ns: 10, title: '模板:关卡报酬/doc', redirect: false },
      { pageid: 1751, ns: 0, title: '阿米娅', redirect: true },
    ],
  },
};

/** 分类成员（标题自带本地化 `分类:` 前缀）。 */
export const CATEGORY_MEMBERS = {
  batchcomplete: '',
  continue: { cmcontinue: 'page|417263686572|18685', continue: '-||' },
  query: {
    categorymembers: [
      { pageid: 1, ns: 0, title: '12F' },
      { pageid: 2, ns: 14, title: '分类:术师干员' },
      { ns: 6, title: '文件:阿米娅头像.png' },
    ],
  },
};

export const CATEGORY_MEMBERS_EMPTY = { batchcomplete: '', query: { categorymembers: [] } };

/** 最近改动（含 `微件:` 命名空间）。 */
export const RECENT_CHANGES = {
  batchcomplete: '',
  continue: { rccontinue: '20261002042426|99763', continue: '-||' },
  query: {
    recentchanges: [
      { type: 'edit', ns: 274, title: '微件:EquipList', pageid: 88001, revid: 99763, old_revid: 99762, oldlen: 1200, newlen: 1345, user: '某编辑者', timestamp: '2026-10-02T04:24:26Z', comment: '同步装备数据' },
      { type: 'new', ns: 10, title: '模板:新模板', pageid: 88002, revid: 99764, oldlen: 0, newlen: 88, user: '甲', timestamp: '2026-10-01T12:00:00Z', comment: '' },
    ],
  },
};

export const RECENT_CHANGES_EMPTY = { batchcomplete: '', query: { recentchanges: [] } };

/** 列表类端点的参数错误。 */
export const API_ERROR_PARAM = { error: { code: 'badvalue', info: 'Unrecognized value for parameter "cmtitle".' } };

/** CDN/WAF 拦截页（HTTP 567 或 200 的空壳）。 */
export const THROTTLE_HTML = [
  '<!doctype html><html lang=zh-CN><meta charset=UTF-8>',
  '<meta content="width=device-width,initial-scale=1" name=viewport><title></title>',
  '<style>*{margin:0;padding:0;box-sizing:border-box}html{background:#fff}</style>',
  '<div class="a1"><div class="a2"></div></div>',
  '</html>',
].join('');

/** 另一种拦截形态：HTTP 200 + 纯数字响应体。 */
export const THROTTLE_BARE_NUMBER = '2623431760697810928';
