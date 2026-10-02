/**
 * HTML → 可读文本的归约器（**纯函数、零依赖**）。
 *
 * PRTS 的页面实测（2026-10-02）：
 *
 * - 单页渲染 HTML **443 KB 起**（`阿米娅` 443,192、`能天使` 469,451），其中 `<style>`
 *   （TemplateStyles）占 8%、`navbox` 与 SMW 数据表占大头；
 * - `display:none` 出现 **374 次**——页签靠它藏未选中的内容，丢了就丢正文；
 * - **SemanticMediaWiki 就是数据本身**（`smw-row/smw-field/smw-value` 各 431 处）。
 *   实测把 `smw-*` 整块删掉，`龙门币` 会少 39 行（约 25%）掉落表——所以默认**不删** smw。
 *
 * ## 一个必须记住的坑：原始文本元素不能按标签配对
 *
 * `<script>` / `<style>` 的内容**不是 HTML**。早先的实现把它们当普通元素做配对计数，
 * 而 PRTS 的内联脚本里含 HTML 字符串（`'<div>'`、`'</span>'` 之类），计数永不归零，
 * 于是**一次吞掉 92.9% 的页面**（443,192 → 435 字符）。
 * 所以 {@link stripRawTextBlocks} 先把它们按「开标签 → 最近的闭合标签」整块摘掉，
 * 之后才允许按标签配对处理。`<style>` 里的 `</div>` 字符串同理。
 *
 * @module dsh-prts/html-text
 */

/** 自闭合标签：不会影响标签配对。 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 原始文本元素：内容不是 HTML，必须整块摘掉而不是数内部标签。 */
export const RAW_TEXT_TAGS = ['script', 'style', 'textarea', 'title'];

/** 整块丢掉的标准噪声标签（含其子树）。 */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'button', 'select', 'option', 'form', 'svg']);

/**
 * 整块丢掉的标准噪声 class。
 *
 * 前一批是 MediaWiki 通用件；后面几项是 PRTS 实测的装饰件：
 * `mdi`（Material Design 图标，109 处）、`mc-tooltips`（99 处悬浮提示）、`hide`。
 *
 * **刻意不含任何 `smw-*`**：在 PRTS 上 SMW 是数据（见模块注释）。
 */
export const DEFAULT_DROP_CLASSES = [
  'mw-editsection',
  'navbox',
  'metadata',
  'catlinks',
  'noprint',
  'mw-jump-link',
  'printfooter',
  'mw-collapsible-toggle',
  'mw-empty-elt',
  'mw-hidden-catlinks',
  'reference',
  'mw-indicators',
  'mw-cite-backlink',
  'toc',
  'hide',
  'mdi',
  'mc-tooltips',
];

/** 按前缀丢掉的 class：PRTS 上**没有**可整类前缀丢弃的东西（bwiki 的 `bwiki-`/`smw-` 都不适用）。 */
export const DEFAULT_DROP_CLASS_PREFIXES = [];

/** 行级噪声正则：PRTS 页面顶部未见整行样板（不像 bwiki 的「编 刷 历 / 首页 >」），默认为空。 */
export const DEFAULT_NOISE_PATTERNS = [];

/**
 * 检索片段里的**行内**噪声：PRTS 用的是 MediaWiki 内置搜索后端，片段是 wikitext 原文，
 * 未见固定样板文字，默认为空（要加就在配置里加）。
 */
export const DEFAULT_SNIPPET_PHRASES = [];

/** 检索片段里的**整句**噪声：PRTS 未见 cookie/版本横幅那类整句样板，默认为空。 */
export const DEFAULT_SNIPPET_SENTENCES = [];

/** 常用的命名实体。 */
const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
  ['mdash', '—'], ['ndash', '–'], ['minus', '−'], ['hellip', '…'], ['middot', '·'],
  ['bull', '•'], ['deg', '°'], ['times', '×'], ['divide', '÷'], ['plusmn', '±'],
  ['laquo', '«'], ['raquo', '»'], ['ldquo', '“'], ['rdquo', '”'], ['lsquo', '‘'], ['rsquo', '’'],
  ['copy', '©'], ['reg', '®'], ['trade', '™'], ['euro', '€'], ['pound', '£'], ['yen', '¥'],
  ['sect', '§'], ['para', '¶'], ['dagger', '†'], ['Dagger', '‡'], ['prime', '′'], ['Prime', '″'],
  ['larr', '←'], ['rarr', '→'], ['uarr', '↑'], ['darr', '↓'], ['harr', '↔'],
  ['shy', ''], ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '], ['zwnj', ''], ['zwj', ''],
]);

/**
 * 解码 HTML 实体（命名 + 十进制 + 十六进制）。
 * @param {string} text - 含实体的文本。
 * @returns {string} 解码后的文本。
 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES.has(body) ? NAMED_ENTITIES.get(body) : match;
  });
}

/**
 * 摘掉原始文本元素（`<script>` / `<style>` / `<textarea>` / `<title>`）的**内容**。
 *
 * 规则：命中开标签后，往后找**最近的**同名闭合标签，整段替换成一个空格；
 * 找不到闭合标签时只摘掉开标签本身、其余内容保留（宁可留噪声也不丢正文）。
 * 这一步必须发生在任何「按标签配对」的删除之前。
 * @param {string} html - HTML。
 * @returns {string} 摘掉原始文本元素后的 HTML。
 */
export function stripRawTextBlocks(html) {
  const source = String(html ?? '');
  const open = new RegExp(`<(${RAW_TEXT_TAGS.join('|')})\\b[^>]*>`, 'gi');
  let out = '';
  let last = 0;
  let match;
  while ((match = open.exec(source)) !== null) {
    const tag = match[1].toLowerCase();
    const close = new RegExp(`</${tag}\\s*>`, 'i').exec(source.slice(match.index + match[0].length));
    out += source.slice(last, match.index) + ' ';
    if (close === null) {
      last = match.index + match[0].length;
      open.lastIndex = last;
      continue;
    }
    last = match.index + match[0].length + close.index + close[0].length;
    open.lastIndex = last;
  }
  return out + source.slice(last);
}

/**
 * 去掉 HTML 注释。
 * @param {string} html - HTML。
 * @returns {string} 无注释的 HTML。
 */
function stripComments(html) {
  return String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * 去掉所有标签并解码实体——用于检索片段这类单行文本。
 *
 * 先摘原始文本元素的内容，再剥标签：只剥标签会把脚本体/CSS 当正文留下来。
 * 摘除位置用空格代替（不是空串），免得英文片段里 `a<script>…</script>b` 粘成 `ab`。
 * @param {string} html - HTML 片段。
 * @returns {string} 纯文本。
 */
export function stripTags(html) {
  return decodeEntities(
    stripRawTextBlocks(stripComments(html)).replace(/<[^>]*>/g, ''),
  ).replace(/\s+/g, ' ').trim();
}

/**
 * 提取正文容器（默认 `<div class="mw-parser-output">`）的主体；找不到时返回原串。
 * @param {string} html - 页面 HTML。
 * @param {string} [className] - 容器 class。
 * @returns {string} 正文 HTML。
 */
export function extractParserOutput(html, className = 'mw-parser-output') {
  // 先把原始文本元素摘掉：它们的内容里可能有 </div> 之类字符串，会把配对计数带偏。
  const source = stripRawTextBlocks(stripComments(html));
  const pattern = new RegExp(`<div[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i');
  const match = pattern.exec(source);
  if (match === null) return source;
  const openEnd = match.index + match[0].length;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  re.lastIndex = openEnd;
  let depth = 1;
  let tag;
  while ((tag = re.exec(source)) !== null) {
    const name = tag[2].toLowerCase();
    if (VOID_TAGS.has(name)) continue;
    if (tag[1] === '/') {
      depth -= 1;
      if (depth === 0) return source.slice(openEnd, tag.index);
    } else {
      depth += 1;
    }
  }
  return source.slice(openEnd);
}

/**
 * 按断点删除整棵子树（`shouldDrop` 命中的元素连内容一起丢）。
 * @param {string} html - HTML。
 * @param {(tag: string, attrs: string) => boolean} shouldDrop - 断点判定。
 * @returns {string} 清理后的 HTML。
 */
export function removeElements(html, shouldDrop) {
  const source = String(html ?? '');
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let out = '';
  let last = 0;
  let dropDepth = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    const [full, closing, rawName, attrs] = match;
    const name = rawName.toLowerCase();
    if (dropDepth === 0) out += source.slice(last, match.index);
    last = match.index + full.length;

    if (VOID_TAGS.has(name)) {
      if (dropDepth === 0) out += full;
      continue;
    }
    if (closing !== '/') {
      if (dropDepth === 0 && shouldDrop(name, attrs)) dropDepth = 1;
      else if (dropDepth > 0) dropDepth += 1;
      else out += full;
      continue;
    }
    if (dropDepth > 0) dropDepth -= 1;
    else out += full;
  }
  if (dropDepth === 0) out += source.slice(last);
  return out;
}

/**
 * 头部噪声判定：装饰/导航块、隐藏块、按前缀命中的站点组件。
 * @param {string} tag - 标签名。
 * @param {string} attrs - 属性串。
 * @param {{ dropTags: Set<string>, dropClasses: string[], dropClassPrefixes: string[] }} options - 选项。
 * @returns {boolean} 是否丢弃。
 */
function isNoise(tag, attrs, options) {
  if (options.dropTags.has(tag)) return true;

  const classMatch = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  const classAttr = classMatch?.[2] ?? classMatch?.[3] ?? '';
  const classes = classAttr.split(/\s+/).filter((name) => name !== '');

  // hidden 属性与内联 display:none：藏起来的多半是悬浮框正文。
  // 但**页签面板除外**：PRTS 的 display:none 有 374 处，未选中的页签内容是真的。
  const tabLike = /tab|panel/i.test(classAttr);
  if (!tabLike && /(^|\s)hidden(\s|>|=|$)/i.test(attrs)) return true;
  const styleMatch = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  const style = styleMatch?.[2] ?? styleMatch?.[3] ?? '';
  if (!tabLike && /display\s*:\s*none/i.test(style)) return true;

  if (options.dropClasses.length > 0 && classes.some((name) => options.dropClasses.includes(name))) return true;
  if (options.dropClassPrefixes.length > 0) {
    return classes.some((name) => options.dropClassPrefixes.some((prefix) => name.startsWith(prefix)));
  }
  return false;
}

/**
 * 选项卡（Tabber 一类）：**保留正文**，只把标签名渲染成一行分隔。
 * @param {string} html - HTML。
 * @returns {string} 转换后的 HTML。
 */
function convertTabs(html) {
  // 注意参数顺序：正则里有 4 个捕获组（标签名、带引号的整串、双引号内、单引号内）。
  const mark = (_match, _tag, _quoted, dq, sq) => `\n【选项卡: ${decodeEntities(dq ?? sq ?? '').trim()}】\n`;
  return html
    .replace(/<(div|section)[^>]*class="[^"]*\btabbertab\b[^"]*"[^>]*\btitle\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, mark)
    .replace(/<(div|section)[^>]*\btitle\s*=\s*("([^"]*)"|'([^']*)')[^>]*class="[^"]*\btabbertab\b[^"]*"[^>]*>/gi, mark);
}

/**
 * 列表转换：`ul` 用 `- `，`ol` 用递增序号，嵌套按深度缩进两格。
 * @param {string} html - HTML。
 * @returns {string} 转换后的 HTML（保留其余标签）。
 */
function convertLists(html) {
  const re = /<(\/?)(ul|ol|li)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  const stack = [];
  const counters = [];
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(html)) !== null) {
    out += html.slice(last, match.index);
    last = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    if (!closing) {
      if (name === 'li') {
        const kind = stack[stack.length - 1];
        const indent = '  '.repeat(Math.max(0, stack.length - 1));
        if (kind === 'ol') {
          counters[counters.length - 1] += 1;
          out += `\n${indent}${counters[counters.length - 1]}. `;
        } else {
          out += `\n${indent}- `;
        }
      } else {
        stack.push(name);
        counters.push(0);
        out += '\n';
      }
    } else if (name === 'ul' || name === 'ol') {
      stack.pop();
      counters.pop();
      out += '\n';
    }
  }
  return out + html.slice(last);
}

/**
 * 表格式转换：整行降成 `| 单元格 | 单元格 |`（PRTS 的数据表很多，这一层最有用）。
 * @param {string} html - HTML。
 * @param {string} marker - 表标题标记。
 * @returns {string} 转换后的 HTML。
 */
function convertTables(html, marker) {
  return html
    .replace(/<caption[^>]*>([\s\S]*?)<\/caption>/gi, (_match, inner) => `\n${marker}${stripTags(inner)}\n`)
    .replace(/<tr[^>]*>/gi, '\n| ')
    .replace(/<t[hd][^>]*>/gi, '')
    .replace(/<\/t[hd]>/gi, ' | ');
}

/**
 * 块级与行内标签转换。
 * @param {string} html - HTML。
 * @param {boolean} keepImages - 是否保留 `[图: alt]`。
 * @returns {string} 转换后的 HTML。
 */
function convertInlineAndBlocks(html, keepImages) {
  // 空强调（`<b></b>`，或里面只有一张被丢掉的图）要整个抹掉，否则会留下孤零零的 `**`。
  const emphasis = (marker) => (_match, _tag, inner) => {
    const text = inner.replace(/<[^>]*>/g, '').trim();
    if (text === '') {
      return keepImages && /<img\b/i.test(inner) ? `${marker}${inner.trim()}${marker}` : '';
    }
    return `${marker}${inner.trim()}${marker}`;
  };
  let out = html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => `\n\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n\n`)
    .replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, emphasis('**'))
    .replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, emphasis('*'))
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => `\`${stripTags(inner)}\``)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => `\n\n\`\`\`\n${decodeEntities(inner).trim()}\n\`\`\`\n\n`)
    .replace(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi, (_m, inner) => `\n${stripTags(inner)}\n`)
    .replace(/<dl[^>]*>/gi, '\n')
    .replace(/<dt[^>]*>/gi, '\n**')
    .replace(/<\/dt>/gi, '**')
    .replace(/<dd[^>]*>/gi, '\n: ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '\n\n')
    .replace(/<\/(div|section|figure|blockquote|table)>/gi, '\n\n')
    .replace(/<(div|section|figure|blockquote)[^>]*>/gi, '\n')
    .replace(/<\/?(span|label|a|abbr|small|big|u|s|del|ins|sub|sup|font|center|time|data|var|kbd|samp|mark|wbr|bdi|bdo|ruby|rt|rp|cite|q|dfn)[^>]*>/gi, '');
  if (!keepImages) return out.replace(/<img[^>]*>/gi, '');
  return out.replace(/<img[^>]*alt\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (_m, _q, dq, sq) => {
    const alt = (dq ?? sq ?? '').trim();
    return alt === '' ? '' : `[图: ${alt}]`;
  });
}

/**
 * 空白展平：行尾去空格、折叠行内多空格、连续空行压成一个。
 * @param {string} text - 文本。
 * @returns {string} 清理后的文本。
 */
function collapseWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/^\s+|\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 按行丢掉命中的样板文字。
 * @param {string} text - 文本。
 * @param {RegExp[]} patterns - 行级噪声正则。
 * @returns {string} 清理后的文本。
 */
function dropNoiseLines(text, patterns) {
  if (patterns.length === 0) return text;
  const kept = text.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (trimmed === '') return true;
    return !patterns.some((pattern) => pattern.test(trimmed));
  });
  return collapseWhitespace(kept.join('\n'));
}

/**
 * 在行边界截断文本。
 * @param {string} text - 文本。
 * @param {number} maxChars - 字符上限。
 * @param {{ toolHint?: string }} [options] - 续读提示里的工具名。
 * @returns {{ text: string, truncated: boolean, totalChars: number }} 截断结果。
 */
export function truncateText(text, maxChars, options = {}) {
  const source = String(text ?? '');
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : Number.POSITIVE_INFINITY;
  if (source.length <= limit) return { text: source, truncated: false, totalChars: source.length };
  const head = source.slice(0, limit);
  const cut = head.lastIndexOf('\n');
  const kept = cut > limit * 0.6 ? head.slice(0, cut) : head;
  const hint = options.toolHint === undefined || options.toolHint === ''
    ? ''
    : ` 用 ${options.toolHint} 看目录，再按 section 分节读取。`;
  return {
    text: `${kept}\n\n[已截断：本文共 ${source.length} 字符，以上为前 ${kept.length} 字符。${hint}]`.trimEnd(),
    truncated: true,
    totalChars: source.length,
  };
}

/**
 * 从归约结果里数出目录（标题来自 `<h1>`–`<h6>`，归约后就是 `#`…`######`）。
 *
 * PRTS 的 `prop=sections` 混着页面自身数字索引与模板来的 `T-1`，所以目录在本地算。
 * `index` 从 1 开始；`0` 表示引言（第一个标题之前）。
 * @param {string} text - 归约后的文本。
 * @returns {{ sections: Array<{ index: number, level: number, title: string, startLine: number, endLine: number }>,
 *   leadEndLine: number, lineCount: number }} 目录。
 */
export function outlineFromText(text) {
  const lines = String(text ?? '').split('\n');
  /** @type {Array<{ index: number, level: number, title: string, startLine: number, endLine: number }>} */
  const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(\S.*)$/.exec(lines[i]);
    if (match === null) continue;
    if (sections.length > 0) sections[sections.length - 1].endLine = i - 1;
    sections.push({ index: sections.length + 1, level: match[1].length, title: match[2].trim(), startLine: i, endLine: lines.length - 1 });
  }
  return {
    sections,
    leadEndLine: sections.length === 0 ? lines.length - 1 : sections[0].startLine - 1,
    lineCount: lines.length,
  };
}

/**
 * 按目录切出一节。
 * @param {string} text - 归约后的文本。
 * @param {{ sections: Array<any>, leadEndLine: number, lineCount: number }} outline - 目录。
 * @param {number} index - `0` 引言，`1..N` 对应 {@link outlineFromText} 的 `index`。
 * @returns {string|undefined} 该节文本；越界时 undefined。
 */
export function sliceSection(text, outline, index) {
  const lines = String(text ?? '').split('\n');
  const wanted = Math.trunc(Number(index));
  if (!Number.isFinite(wanted) || wanted < 0) return undefined;
  if (wanted === 0) return lines.slice(0, outline.leadEndLine + 1).join('\n').trim();
  const section = outline.sections[wanted - 1];
  if (section === undefined) return undefined;
  return lines.slice(section.startLine, section.endLine + 1).join('\n').trim();
}

/**
 * 把配置里的噪声设置收成运行时形状（永不抛错：写错的正则忽略）。
 * @param {Record<string, unknown>} [options] - 原始选项。
 * @returns {Record<string, any>} 归一后的选项。
 */
function normalizeOptions(options = {}) {
  const asStringList = (value, fallback) => {
    if (!Array.isArray(value)) return [...fallback];
    return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  };
  const patterns = [];
  if (Array.isArray(options.noisePatterns)) {
    for (const raw of options.noisePatterns) {
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      try {
        patterns.push(new RegExp(raw));
      } catch {
        // 配置里写错的正则直接忽略：不该因此让工具报错。
      }
    }
  }
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? Math.trunc(options.maxChars) : Number.POSITIVE_INFINITY;
  return {
    dropClasses: asStringList(options.dropClasses, DEFAULT_DROP_CLASSES),
    dropClassPrefixes: asStringList(options.dropClassPrefixes, DEFAULT_DROP_CLASS_PREFIXES),
    noisePatterns: patterns,
    keepImages: options.keepImages === true,
    tableMarker: typeof options.tableMarker === 'string' && options.tableMarker !== '' ? options.tableMarker : '【表】',
    parserOutputOnly: options.parserOutputOnly !== false,
    dropTags: new Set(asStringList(options.dropTags, [...DROP_TAGS])),
    maxChars,
    toolHint: typeof options.toolHint === 'string' ? options.toolHint : '',
  };
}

/**
 * 页面 HTML → 可读文本（+ 目录）。
 * @param {string} html - `action=parse&prop=text` 的 `parse.text`。
 * @param {{ maxChars?: number, keepImages?: boolean, dropClasses?: unknown, dropClassPrefixes?: unknown,
 *   noisePatterns?: unknown, dropTags?: unknown, tableMarker?: string, parserOutputOnly?: boolean,
 *   toolHint?: string }} [options] 选项。
 * @returns {{ text: string, truncated: boolean, totalChars: number,
 *   outline: { sections: Array<object>, leadEndLine: number, lineCount: number } }} 归约结果。
 */
export function toText(html, options = {}) {
  const opts = normalizeOptions(options);
  const prepared = stripComments(html);
  const raw = opts.parserOutputOnly ? extractParserOutput(prepared) : stripRawTextBlocks(prepared);
  let working = removeElements(raw, (tag, attrs) => isNoise(tag, attrs, opts));
  working = convertTabs(working);
  working = convertTables(working, opts.tableMarker);
  working = convertLists(working);
  working = convertInlineAndBlocks(working, opts.keepImages);
  const plain = dropNoiseLines(collapseWhitespace(decodeEntities(working.replace(/<[^>]*>/g, ''))), opts.noisePatterns);
  const outline = outlineFromText(plain);
  // 目录永远基于**完整**文本算，截断只影响返回的正文——否则 section 切片会随 maxChars 漂移。
  const truncated = truncateText(plain, opts.maxChars, { toolHint: opts.toolHint });
  return { text: truncated.text, truncated: truncated.truncated, totalChars: truncated.totalChars, outline };
}

/**
 * 把 wikitext 片段降成可读文本。
 *
 * PRTS 用的是 MediaWiki 内置搜索后端，**片段是 wikitext 原文**（实测形如
 * `|名称=能天使的中坚信物 |用途=用于提升…`），所以这里做最小归约：
 * 去掉模板调用、把 `[[目标|显示]]` 收敛成显示文字、去掉强调符号与表格标记。
 * @param {string} text - wikitext 片段。
 * @returns {string} 归约后的文本。
 */
export function reduceWikitext(text) {
  let out = String(text ?? '');
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(/\{\{[^{}]*\}\}/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/\{\|[\s\S]*?\|\}/g, ' ')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[(https?:\/\/\S+)\s+([^\]]*)\]/g, '$2')
    .replace(/'{2,}/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把检索片段洗干净。
 *
 * 两级处理（与另一个插件的实现同源）：
 * 1. **行内噪声**（`DEFAULT_SNIPPET_PHRASES`）按词删——缩略图报错那类文字夹在正文中间，
 *    整句删会把真内容一起带走；
 * 2. **整句噪声**（`DEFAULT_SNIPPET_SENTENCES`）按句子删——cookie 提示、版本横幅是整句样板。
 *
 * 这里额外做一次 wikitext 归约（PRTS 的片段是 wikitext 原文）。
 * @param {string} html - 片段。
 * @param {{ phrases?: string[], sentences?: string[] }} [options] - 覆盖默认词表（测试用）。
 * @returns {string} 干净文本。
 */
export function cleanSnippet(html, options = {}) {
  const phrases = Array.isArray(options.phrases) ? options.phrases : DEFAULT_SNIPPET_PHRASES;
  const sentences = (Array.isArray(options.sentences) ? options.sentences : DEFAULT_SNIPPET_SENTENCES)
    .filter((item) => typeof item === 'string' && item !== '')
    .map((item) => item.toLowerCase());

  let text = reduceWikitext(stripTags(html));
  for (const phrase of phrases) {
    if (typeof phrase === 'string' && phrase !== '') text = text.split(phrase).join(' ');
  }

  /** @type {string[]} */
  const kept = [];
  // 中文句末标点与 `☆` 直接断句；半角 `!`/`?` 只在**后面跟空白或行尾**时断，
  // 否则 URL（或代码）里的 `?` 会把句子切碎。
  for (const segment of text.split(/(?<=[。！？；☆])|(?<=[!?])(?=\s|$)|\n+/u)) {
    const trimmed = segment.trim();
    if (trimmed === '') continue;
    const lowered = trimmed.toLowerCase();
    if (sentences.some((sentence) => lowered.includes(sentence))) continue;
    kept.push(trimmed);
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}
