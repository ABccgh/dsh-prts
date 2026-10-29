/**
 * wikitext 模板解析（**纯函数、离线可测、零依赖**）。
 *
 * PRTS 的干员/材料页正文大量由模板驱动（`{{CharinfoV2|…}}`、`{{干员获得方式|…}}`），
 * 想拿结构化字段就得先把模板调用解析出来。MediaWiki 的模板语法比正则复杂：
 *
 * - 参数用 `|` 分隔，命名参数用第一个顶层 `=`（`稀有度=5`）；
 * - 模板可以**嵌套**（`{{color|#0098DC|{{+|6|+6}}}}`），嵌套里的 `|` 不切外层参数；
 * - 链接 `[[4-10|4-10]]` 里的 `|` 也不是参数分隔符；
 * - 注释 `<!-- … -->` 里可以出现 `{{`/`}}`，必须整段跳过；
 * - `{{!}}` 是「字面管道符」，在参数值里应还原成 `|`；
 * - 模板调用经常跨多行（自动更新区）。
 *
 * 所以这里按字符扫一遍、维护一个模板栈来解析，而不是用正则硬切。
 * 解析有上限（输入字符 / 模板数 / 每模板参数数 / 每个值字符数），超限置 `truncated` 并记原因，
 * 绝不因为一个异常页面把调用方拖死。
 *
 * 返回的模板对象：
 *
 * ```js
 * { name: 'CharinfoV2', params: { 稀有度: '5' }, positional: [], depth: 1, line: 8 }
 * ```
 *
 * - `name` 是去掉 `模板:` / `Template:` / `subst:` 前缀后的名字；
 * - `params` 只收命名参数（键去空白、重复键后者覆盖）；
 * - `positional` 是按出现顺序的匿名参数（值去首尾空白，内部换行保留）；
 * - `depth` 1 = 顶层模板，>1 = 嵌套（父模板的对应参数值里仍是**原文**，含嵌套调用）；
 * - `line` 是模板起始行号（1 起）。
 *
 * @module dsh-prts/wikitext
 */

/** 默认上限。 */
export const WIKITEXT_LIMITS = {
  /** 输入 wikitext 最多扫描多少字符。 */
  maxInputChars: 1_000_000,
  /** 最多返回多少个模板。 */
  maxTemplates: 500,
  /** 单个模板最多收多少个参数（命名 + 匿名）。 */
  maxParams: 200,
  /** 单个参数值最多保留多少字符。 */
  maxValueChars: 8_000,
};

/** 截断标记。 */
const TRUNCATED_MARK = '…（已截断）';

/**
 * 取有界整数。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 整数。
 */
function intIn(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * 归一模板名：去空白、去 `subst:` / `safesubst:` / `模板:` / `Template:` 前缀。
 * @param {unknown} name - 原始模板名。
 * @returns {string} 归一后的名字。
 */
export function normalizeTemplateName(name) {
  let text = String(name ?? '').trim();
  for (let round = 0; round < 3; round += 1) {
    const before = text;
    text = text.replace(/^(?:subst|safesubst)\s*:\s*/i, '');
    text = text.replace(/^(?:模板|template)\s*:\s*/i, '');
    if (text === before) break;
  }
  return text.trim();
}

/**
 * 两个模板名是否相同（忽略大小写与前缀）。
 * @param {string} left - 名字。
 * @param {string} right - 名字。
 * @returns {boolean} 相同为 true。
 */
export function sameTemplateName(left, right) {
  return normalizeTemplateName(left).toLowerCase() === normalizeTemplateName(right).toLowerCase();
}

/**
 * 解析一段 wikitext 里的全部模板调用。
 * @param {unknown} wikitext - 页面源码。
 * @param {{ maxInputChars?: number, maxTemplates?: number, maxParams?: number, maxValueChars?: number }} [options]
 *   覆盖默认上限。
 * @returns {{ templates: Array<{ name: string, params: Record<string, string>,
 *   positional: string[], depth: number, line: number }>, truncated: boolean,
 *   truncatedReasons: string[], length: number }} 解析结果。
 */
export function parseTemplates(wikitext, options = {}) {
  const source = typeof wikitext === 'string' ? wikitext : String(wikitext ?? '');
  const maxInputChars = intIn(options.maxInputChars, WIKITEXT_LIMITS.maxInputChars, 1000, 8_000_000);
  const maxTemplates = intIn(options.maxTemplates, WIKITEXT_LIMITS.maxTemplates, 1, 5000);
  const maxParams = intIn(options.maxParams, WIKITEXT_LIMITS.maxParams, 1, 2000);
  const maxValueChars = intIn(options.maxValueChars, WIKITEXT_LIMITS.maxValueChars, 16, 64_000);

  /** @type {string[]} */
  const truncatedReasons = [];
  let text = source;
  if (text.length > maxInputChars) {
    text = text.slice(0, maxInputChars);
    truncatedReasons.push('input');
  }

  /** @type {Array<{ name: string, params: Record<string, string>, positional: string[], depth: number, line: number }>} */
  const templates = [];
  /** 模板栈。 */
  const stack = [];
  let line = 1;
  let index = 0;
  let stopped = false;

  /**
   * 数一段文本里有多少换行。
   * @param {number} from - 起点。
   * @param {number} to - 终点（不含）。
   * @returns {number} 换行数。
   */
  const newlinesBetween = (from, to) => {
    let count = 0;
    for (let at = from; at < to; at += 1) {
      if (text[at] === '\n') count += 1;
    }
    return count;
  };

  /**
   * 往当前模板的「名字」或「当前参数值」追加文本（受 maxValueChars 限制）。
   * @param {any} frame - 当前模板帧。
   * @param {string} chunk - 追加内容。
   * @returns {void}
   */
  const appendRaw = (frame, chunk) => {
    if (chunk === '') return;
    if (frame.inName) {
      if (frame.nameBuf.length < 400) frame.nameBuf += chunk.slice(0, 400 - frame.nameBuf.length);
      return;
    }
    if (frame.valueTruncated) return;
    const room = maxValueChars - frame.buf.length;
    if (chunk.length <= room) {
      frame.buf += chunk;
      return;
    }
    frame.buf += chunk.slice(0, Math.max(0, room));
    frame.valueTruncated = true;
    if (!truncatedReasons.includes('value')) truncatedReasons.push('value');
  };

  /**
   * 结束当前参数段，收进 params / positional。
   * @param {any} frame - 当前模板帧。
   * @returns {void}
   */
  const flushSegment = (frame) => {
    const count = Object.keys(frame.params).length + frame.positional.length;
    if (count >= maxParams) {
      frame.paramsTruncated = true;
      if (!truncatedReasons.includes('params')) truncatedReasons.push('params');
      frame.buf = '';
      frame.hasEq = false;
      frame.key = '';
      frame.valueTruncated = false;
      return;
    }
    let value = frame.buf.trim();
    if (frame.valueTruncated) value = `${value}${TRUNCATED_MARK}`;
    if (frame.hasEq) {
      const key = frame.key.trim();
      if (key !== '') frame.params[key] = value;
      else frame.positional.push(value);
    } else {
      frame.positional.push(value);
    }
    frame.buf = '';
    frame.hasEq = false;
    frame.key = '';
    frame.valueTruncated = false;
  };

  while (index < text.length) {
    // 注释整段跳过（里面可以有任何括号）。
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      const stop = end < 0 ? text.length : end + 3;
      line += newlinesBetween(index, stop);
      index = stop;
      continue;
    }

    const char = text[index];

    // 模板开：压栈。
    if (char === '{' && text[index + 1] === '{') {
      if (templates.length >= maxTemplates) {
        if (!truncatedReasons.includes('templates')) truncatedReasons.push('templates');
        stopped = true;
        break;
      }
      stack.push({
        start: index,
        line,
        depth: stack.length + 1,
        inName: true,
        nameBuf: '',
        params: {},
        positional: [],
        buf: '',
        hasEq: false,
        key: '',
        valueTruncated: false,
        linkDepth: 0,
        paramsTruncated: false,
      });
      index += 2;
      continue;
    }

    // 模板关：弹栈并记录；把原文（或 {{!}} → |）回填给父模板当前参数。
    if (char === '}' && text[index + 1] === '}') {
      const frame = stack.pop();
      if (frame === undefined) {
        index += 2;
        continue;
      }
      if (!frame.inName) flushSegment(frame);
      const raw = text.slice(frame.start, index + 2);
      const name = normalizeTemplateName(frame.nameBuf);
      templates.push({
        name,
        params: frame.params,
        positional: frame.positional,
        depth: frame.depth,
        line: frame.line,
      });
      const parent = stack[stack.length - 1];
      if (parent !== undefined) {
        appendRaw(parent, name === '!' ? '|' : raw);
      }
      index += 2;
      continue;
    }

    const frame = stack[stack.length - 1];

    if (frame !== undefined) {
      // 链接 [[…]]：里面的 | 与 = 都不切参数。
      if (char === '[' && text[index + 1] === '[') {
        frame.linkDepth += 1;
        appendRaw(frame, '[[');
        index += 2;
        continue;
      }
      if (char === ']' && text[index + 1] === ']' && frame.linkDepth > 0) {
        frame.linkDepth -= 1;
        appendRaw(frame, ']]');
        index += 2;
        continue;
      }
      if (frame.linkDepth === 0) {
        if (char === '|') {
          if (frame.inName) {
            frame.inName = false;
          } else {
            flushSegment(frame);
          }
          index += 1;
          continue;
        }
        if (char === '=' && !frame.inName && !frame.hasEq) {
          frame.hasEq = true;
          frame.key = frame.buf;
          frame.buf = '';
          index += 1;
          continue;
        }
      }
    }

    // 普通字符：计入换行数并回填到最内层模板。
    if (char === '\n') line += 1;
    if (frame !== undefined) appendRaw(frame, char);
    index += 1;
  }

  if (stack.length > 0 && !stopped && !truncatedReasons.includes('unclosed-template')) {
    truncatedReasons.push('unclosed-template');
  }
  if (stopped && !truncatedReasons.includes('templates')) truncatedReasons.push('templates');

  // 按文档顺序输出（行号升序；同一行先顶层后嵌套），便于调用方与测试稳定断言。
  templates.sort((left, right) => left.line - right.line || left.depth - right.depth);

  return {
    templates,
    truncated: truncatedReasons.length > 0,
    truncatedReasons,
    length: source.length,
  };
}

/**
 * 找匹配名字的模板（顶层优先，其次嵌套）。
 * @param {Array<{ name: string, depth: number }>} templates - `parseTemplates` 的模板表。
 * @param {string|string[]} names - 一个或多个名字（大小写、`模板:` 前缀不敏感）。
 * @returns {Array<Record<string, any>>} 匹配到的模板（按文档顺序，顶层在前）。
 */
export function findTemplates(templates, names) {
  const list = Array.isArray(names) ? names : [names];
  const wanted = list.map((name) => normalizeTemplateName(name).toLowerCase()).filter((name) => name !== '');
  if (wanted.length === 0) return [];
  const matched = (Array.isArray(templates) ? templates : [])
    .filter((template) => wanted.includes(normalizeTemplateName(template?.name).toLowerCase()));
  return [...matched].sort((left, right) => {
    const depthDiff = (left.depth ?? 1) - (right.depth ?? 1);
    return depthDiff !== 0 ? depthDiff : (left.line ?? 0) - (right.line ?? 0);
  });
}

/**
 * 找第一个匹配名字的模板（优先顶层）。
 * @param {Array<{ name: string, depth: number }>} templates - 模板表。
 * @param {string|string[]} names - 名字。
 * @returns {Record<string, any> | null} 模板或 null。
 */
export function findTemplate(templates, names) {
  const matched = findTemplates(templates, names);
  return matched.length > 0 ? matched[0] : null;
}
