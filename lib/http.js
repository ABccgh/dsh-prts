/**
 * 出网层：带上诚实的 User-Agent、管超时与重试、处理 TLS 证书、在遇到拦截图时给出可执行的指引。
 *
 * ## 拦截页 / 非 JSON 响应长什么样
 *
 * 站点 CDN/WAF 偶尔会返回不是 JSON 的响应（bwiki 系站点实测过下面两类，本插件按同样的方式兜）：
 *
 * | 现象 | 实测 |
 * | --- | --- |
 * | **HTTP 567** + HTML 空壳（`server: TencentEdgeOne`） | 连发 6 次里出现 1 次；间隔 ~2.5 s 的下一次请求恢复 200 |
 * | HTTP 200 但响应体是 HTML | 同一形态的挑战页 |
 * | User-Agent 无关 | 带联系地址的机器人 UA 与伪装浏览器的 UA **都能**正常拿到 JSON |
 *
 * 结论：这不是 UA 墙，是**突发节流**。所以这里的策略是「退避重试」而不是「换 UA」：
 * 按 `throttleAttempts` / `throttleBaseDelayMs` 递增退避重试（总等待有上限），
 * 全部失败才走 DSH `web` 服务兜底，最后给出「稍后再试」这类可执行的话。
 *
 * 由于是节流，**不要伪装浏览器**、也不要狂发请求；默认 UA 保留「名字 + 联系地址」的写法
 * （这也符合 MediaWiki 自己的 UA 政策）。真实抓取频率由 `cacheTtlMs` 压着。
 *
 * 不自己管代理：DSH 已经把 undici 的全局 dispatcher 装好，这里的 `fetch` 自动走同一套策略。
 *
 * @module dsh-prts/http
 */

import tls from 'node:tls';

/** 表示「证书链验证不过」的错误码。 */
const CERTIFICATE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
]);

/** 合并系统 CA 的结果；进程内只做一次。 */
let systemCaState = { merged: false, added: 0, total: 0, error: undefined };

/**
 * 沿 `cause` 链找到第一个带 `code` 的错误码。undici 会把真实原因藏在 `error.cause.cause`。
 * @param {unknown} cause - 捕获到的异常。
 * @returns {string} 错误码，找不到时为空字符串。
 */
export function findErrorCode(cause) {
  let current = cause;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') return current.code;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return '';
}

/**
 * 沿 `cause` 链找最内层的可读消息。
 * @param {unknown} cause - 捕获到的异常。
 * @returns {string} 消息文本。
 */
function deepestMessage(cause) {
  let current = cause;
  let message = '';
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof Error && current.message) message = current.message;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return message;
}

/**
 * 判断异常是不是证书验证失败。
 * @param {unknown} cause - 捕获到的异常。
 * @returns {boolean} 是否属于证书问题。
 */
export function isCertificateError(cause) {
  return CERTIFICATE_CODES.has(findErrorCode(cause)) || /certificate|self.signed/i.test(deepestMessage(cause));
}

/**
 * 把系统根证书并入 Node 默认的 CA 列表。幂等，进程内只生效一次。
 * @returns {{ merged: boolean, added: number, total: number, error?: string }} 合并结果。
 */
export function ensureSystemCaTrusted() {
  if (systemCaState.merged || systemCaState.error !== undefined) return systemCaState;
  try {
    const current = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    const before = current.length;
    tls.setDefaultCACertificates([...new Set([...current, ...system])]);
    // 读回来的数量才是生效值：setDefaultCACertificates 会丢弃它不接受的条目，
    // 也可能按内容去重，所以不能用拼出来的数组长度当结果。
    const observed = tls.getCACertificates('default').length;
    systemCaState = { merged: true, added: Math.max(0, observed - before), total: observed };
  } catch (cause) {
    systemCaState = {
      merged: false,
      added: 0,
      total: 0,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return systemCaState;
}

/**
 * 当前的系统 CA 合并状态（供 `prts_status` 诊断用）。
 * @returns {{ merged: boolean, added: number, total: number, error?: string }} 状态快照。
 */
export function systemCaStatus() {
  return { ...systemCaState };
}

/**
 * 针对错误码给出可执行的建议。
 * @param {string} code - 归一化后的错误码。
 * @returns {string} 建议文本（可能为空）。
 */
export function hintForCode(code) {
  if (code === 'ECONNREFUSED') {
    return '连接被拒绝：本机 hosts 可能把该域名指向了 127.0.0.1（Steam++ / Watt Toolkit 之类的加速工具），但加速器当前没有运行。启动加速器，或把它的 hosts 加速模式关掉再试。';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败：检查网络与 DNS。';
  if (CERTIFICATE_CODES.has(code)) {
    return 'TLS 证书链无法验证：多半是本机加速器用自签名证书接管了该域名。保持 trustSystemCa 为 auto（默认）或 always。';
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时：检查网络或代理。';
  if (code === 'ECONNRESET') return '连接被重置：可能是网络中间设备中断了请求，重试一次通常就好。';
  return '';
}

/**
 * 把 HTTP 状态码翻译成可执行的建议。
 * @param {number} status - 状态码。
 * @returns {string} 建议文本（可能为空）。
 */
export function explainHttpStatus(status) {
  switch (status) {
    case 400:
      return '请求参数被 wiki 拒绝（常见原因：标题里的特殊字符没编码好、参数超出匿名上限）';
    case 403:
      return '被拒绝：可能是频次限制或反爬规则——放慢调用（缓存已默认开启），不要伪装浏览器';
    case 404:
      return '接口路径不存在：检查 apiPath 配置（PRTS 是 /api.php）';
    case 429:
      return '被限流，稍后重试';
    case 567:
      return '被 CDN/WAF 拦下（非标准状态码 567）：这是临时状态，退避重试即可恢复';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'wiki 侧暂时不可用';
    default:
      if (status >= 500) return '非标准的 5xx 状态码：多半是 CDN/WAF 拦截，稍后重试';
      return '';
  }
}

/**
 * 这个状态码是否值得重试。
 * @param {number} status - 状态码。
 * @param {number} [retryAfterMs] - 服务端要求的等待时间。
 * @returns {boolean} 是否重试。
 */
export function isRetryableStatus(status, retryAfterMs) {
  if (status === 429) return true;
  if (status === 567) return true;
  if (status >= 500 && status <= 599) return true;
  if (status === 403 && Number.isFinite(retryAfterMs)) return true;
  return false;
}

/**
 * 判断响应体是不是「不是 JSON」的样子（WAF 空壳、HTML 维护页、纯数字拦截码）。
 *
 * 只看**内容**，不看状态码：CDN/WAF 既可能用 567 回拦截页，也可能用 200 回 HTML 空壳。
 * @param {{ headers?: { get?: Function } }} response - fetch 响应。
 * @param {string} body - 响应体文本。
 * @returns {boolean} 是否不是可解析的 JSON 响应。
 */
export function isUnexpectedHtmlBody(response, body) {
  const contentType = String(response?.headers?.get?.('content-type') ?? '').toLowerCase();
  const head = String(body ?? '').trimStart().slice(0, 200);
  if (head.startsWith('{') || head.startsWith('[')) return false;
  const lowered = head.toLowerCase();
  return contentType.includes('html')
    || contentType.includes('json')
    || lowered.startsWith('<!doctype')
    || lowered.startsWith('<html')
    || /^\d{6,}$/.test(head);
}

/**
 * 把「不是 JSON 的响应」翻译成一段人能照着做的话。
 * @param {{ url: string, status?: number, server?: string, attempts?: number, userAgent?: string }} info - 上下文。
 * @returns {string} 报错正文。
 */
export function unexpectedBodyMessage(info) {
  const status = info.status === undefined ? '未知' : String(info.status);
  return [
    '接口返回了 HTML/非 JSON 内容，而不是 MediaWiki 的 JSON。',
    `请求：${info.url}`,
    `状态：HTTP ${status}${info.server === undefined ? '' : `，server=${info.server}`}；已尝试 ${info.attempts ?? 1} 次。`,
    '站点在 CDN/WAF 之后：实测会突发返回 HTTP 567 或 200 + HTML 空壳（与 User-Agent 无关）。',
    '对策：稍后重试（同一 URL 隔一两秒再请求通常就恢复），或让模型少发重复请求（缓存默认 5 分钟）。',
    info.userAgent === undefined ? '' : `当前 User-Agent：${info.userAgent}`,
  ].filter((line) => line !== '').join('\n');
}

/**
 * 从 DSH `web` 服务的返回里取出可解析的 JSON。
 * @param {{ statusCode?: number, body?: { content?: string } }} result - WebFetchResult。
 * @returns {{ status: number, data: unknown } | undefined} 解析成功时的结果。
 */
export function jsonFromWebFetch(result) {
  const content = result?.body?.content;
  if (typeof content !== 'string') return undefined;
  try {
    return { status: Number(result?.statusCode ?? 0), data: JSON.parse(content) };
  } catch {
    return undefined;
  }
}

/** 服务器要求的等待时间（秒或 HTTP 日期），上限 3 秒。 */
function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  if (raw === null || raw === undefined || raw === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(3000, Math.max(0, seconds * 1000));
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(3000, Math.max(0, when - Date.now()));
  return undefined;
}

/**
 * 可被中断的等待。
 * @param {number} ms - 毫秒。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<void>} 无。
 */
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** 把数值收进范围内。 */
function clampInt(value, fallback, min, max) {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * 取一次 JSON。调用方永远不需要 try/catch。
 *
 * 重试预算：`throttleAttempts` 是**总尝试次数**（默认 3）。退避为
 * `throttleBaseDelayMs × 第几次`，且累计等待不超过 `throttleMaxWaitMs`（默认 10 s），
 * 免得把一次工具调用拖死。证书错误的「并入系统 CA 再试一次」不占这个预算。
 * @param {string} url - 完整 URL。
 * @param {{ timeoutMs?: number, userAgent?: string, throttleAttempts?: number,
 *   throttleBaseDelayMs?: number, throttleMaxWaitMs?: number, signal?: AbortSignal,
 *   trustSystemCa?: 'auto'|'always'|'never', fetchImpl?: Function, webFallback?: boolean,
 *   getWeb?: () => any }} options - 选项。
 * @returns {Promise<{ ok: true, status: number, data: unknown, url: string, via: 'http'|'dsh-web',
 *   attempts: number, server?: string } |
 *   { ok: false, error: string, url: string, hint?: string, code?: string, status?: number, body?: string,
 *   unexpectedBody?: boolean, aborted?: boolean, via?: string, attempts: number, server?: string }>} 归一化结果。
 */
export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const userAgent = options.userAgent ?? 'dsh-prts/0.1';
  const trustSystemCa = options.trustSystemCa ?? 'auto';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const attemptsMax = clampInt(options.throttleAttempts, 3, 1, 6);
  const baseDelayMs = clampInt(options.throttleBaseDelayMs, 1200, 0, 10_000);
  const maxWaitMs = clampInt(options.throttleMaxWaitMs, 10_000, 0, 30_000);
  const headers = { Accept: 'application/json', 'User-Agent': userAgent, ...(options.headers ?? {}) };

  if (trustSystemCa === 'always') ensureSystemCaTrusted();

  let attempt = 0;
  let waitedMs = 0;
  let caRetryUsed = false;
  let unexpectedBody = false;
  let lastCode = '';
  let lastMessage = '请求失败';
  let lastHint = '';
  let lastStatus;
  let lastBody;
  let lastServer;
  let lastHttpStatus;

  while (attempt < attemptsMax) {
    if (options.signal?.aborted) return { ok: false, error: '请求已被取消', url, aborted: true, attempts: attempt };

    attempt += 1;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      const response = await fetchImpl(url, { headers, signal, redirect: 'follow' });
      const text = await response.text();
      lastStatus = response.status;
      lastServer = response.headers?.get?.('server') ?? undefined;

      if (!response.ok) {
        const wait = retryAfterMs(response);
        lastBody = text.slice(0, 400);
        lastMessage = `HTTP ${response.status}`;
        lastHint = explainHttpStatus(response.status);
        const retryable = isRetryableStatus(response.status, wait);
        const delay = wait ?? baseDelayMs * attempt;
        if (retryable && attempt < attemptsMax && waitedMs + delay <= maxWaitMs) {
          waitedMs += delay;
          await sleep(delay, signal);
          continue;
        }
        // 不可重试的客户端错误（400/404…）：直接返回，别浪费兜底通道。
        if (!retryable) {
          return {
            ok: false,
            status: response.status,
            error: `HTTP ${response.status}${lastHint === '' ? '' : `：${lastHint}`}`,
            hint: lastHint,
            body: lastBody,
            url,
            attempts: attempt,
            server: lastServer,
          };
        }
        // 可重试但次数用尽：留给下面的 DSH web 兜底通道再试一次。
        lastHttpStatus = response.status;
        break;
      }

      if (isUnexpectedHtmlBody(response, text)) {
        unexpectedBody = true;
        lastBody = text.slice(0, 400);
        lastMessage = '响应不是合法的 JSON';
        lastHint = '疑似 CDN/WAF 拦截页（非 JSON 响应，可能是 HTTP 567 或 200 + HTML 空壳），稍后重试。';
        const delay = baseDelayMs * attempt;
        if (attempt < attemptsMax && waitedMs + delay <= maxWaitMs) {
          waitedMs += delay;
          await sleep(delay, signal);
          continue;
        }
        break;
      }

      try {
        return {
          ok: true,
          status: response.status,
          data: JSON.parse(text),
          url,
          via: 'http',
          attempts: attempt,
          server: lastServer,
        };
      } catch {
        unexpectedBody = true;
        lastMessage = '响应不是合法的 JSON';
        lastHint = '响应看起来被中间层替换过了，稍后重试。';
        lastBody = text.slice(0, 400);
        const delay = baseDelayMs * attempt;
        if (attempt < attemptsMax && waitedMs + delay <= maxWaitMs) {
          waitedMs += delay;
          await sleep(delay, signal);
          continue;
        }
        break;
      }
    } catch (cause) {
      if (options.signal?.aborted) return { ok: false, error: '请求已被取消', url, aborted: true, attempts: attempt };

      lastCode = findErrorCode(cause);
      lastMessage = deepestMessage(cause) || (cause instanceof Error ? cause.message : String(cause));
      lastHint = hintForCode(lastCode);

      // 证书错误：把系统根证书并进来再试一次。这次重试不占普通重试预算，且最多一次。
      if (trustSystemCa !== 'never' && !caRetryUsed && isCertificateError(cause)) {
        caRetryUsed = true;
        const state = ensureSystemCaTrusted();
        if (state.merged && state.added > 0) {
          attempt -= 1;
          continue;
        }
        lastHint = state.error !== undefined
          ? `TLS 证书验证失败，且无法读取系统根证书：${state.error}`
          : 'TLS 证书验证失败；系统根证书已合并但问题依旧，请检查加速器或改用代理。';
      }

      if (lastCode === 'TimeoutError' || lastMessage === 'The operation was aborted due to timeout') {
        lastMessage = '请求超时';
        lastCode = 'ETIMEDOUT';
        lastHint = hintForCode('ETIMEDOUT');
      }

      const delay = baseDelayMs * attempt;
      if (attempt < attemptsMax && waitedMs + delay <= maxWaitMs) {
        waitedMs += delay;
        await sleep(delay, signal);
        continue;
      }
      break;
    }
  }

  // 兜底：同一 URL 交给 DSH 自己的 web 服务再取一次。
  if (options.webFallback !== false && typeof options.getWeb === 'function') {
    const web = safeGetWeb(options.getWeb);
    if (web !== undefined) {
      try {
        const result = await web.fetch({ url }, options.signal);
        const parsed = jsonFromWebFetch(result);
        if (parsed !== undefined) {
          return { ok: true, status: parsed.status || 200, data: parsed.data, url, via: 'dsh-web', attempts: attempt };
        }
        return {
          ok: false,
          error: `${lastMessage}；改用 DSH web 服务兜底后仍拿不到 JSON。`,
          hint: lastHint,
          unexpectedBody,
          body: lastBody,
          url,
          via: 'dsh-web',
          attempts: attempt,
          server: lastServer,
        };
      } catch (cause) {
        lastMessage = `${lastMessage}；DSH web 服务兜底也失败：${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
  }

  if (unexpectedBody) {
    return {
      ok: false,
      error: unexpectedBodyMessage({ url, status: lastStatus, server: lastServer, attempts: attempt, userAgent }),
      hint: '这类拦截是临时的，不是配置错误：等一两秒重试同一次调用通常就恢复。',
      unexpectedBody: true,
      status: lastStatus,
      body: lastBody,
      url,
      attempts: attempt,
      server: lastServer,
    };
  }

  if (lastHttpStatus !== undefined) {
    return {
      ok: false,
      status: lastHttpStatus,
      error: `HTTP ${lastHttpStatus}${lastHint === '' ? '' : `：${lastHint}`}`,
      hint: lastHint === '' ? '可重试的状态码：稍后重试同一次调用。' : lastHint,
      body: lastBody,
      url,
      attempts: attempt,
      server: lastServer,
    };
  }

  const suffix = lastMessage === '请求超时' ? `（超过 ${timeoutMs} ms）` : '';
  return {
    ok: false,
    error: `${lastMessage}${suffix}`,
    hint: lastHint,
    code: lastCode,
    status: lastStatus,
    body: lastBody,
    url,
    attempts: attempt,
    server: lastServer,
  };
}

/**
 * 安全地拿 `web` 服务：没有该服务、或调用抛错时都返回 undefined，不该因此让工具失败。
 * @param {() => any} getWeb - 取服务函数。
 * @returns {any|undefined} 服务实例。
 */
function safeGetWeb(getWeb) {
  try {
    const web = getWeb();
    return web !== undefined && web !== null && typeof web.fetch === 'function' ? web : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 造一个带上默认超时、UA、退避重试、证书策略与兜底通道的取数器。
 * @param {{ timeoutMs?: number, userAgent?: string, trustSystemCa?: 'auto'|'always'|'never',
 *   throttleAttempts?: number, throttleBaseDelayMs?: number, throttleMaxWaitMs?: number,
 *   fetchImpl?: Function, webFallback?: boolean, getWeb?: () => any }} [defaults] - 默认值。
 * @returns {{ json: (url: string, options?: object) => Promise<object>, timeoutMs: number,
 *   userAgent: string, trustSystemCa: string }} 取数器。
 */
export function createHttpClient(defaults = {}) {
  const timeoutMs = defaults.timeoutMs ?? 20_000;
  const userAgent = defaults.userAgent ?? 'dsh-prts/0.1';
  const trustSystemCa = defaults.trustSystemCa ?? 'auto';
  const webFallback = defaults.webFallback !== false;
  return {
    timeoutMs,
    userAgent,
    trustSystemCa,
    json(url, options = {}) {
      return fetchJson(url, {
        timeoutMs,
        userAgent,
        trustSystemCa,
        throttleAttempts: defaults.throttleAttempts ?? 3,
        throttleBaseDelayMs: defaults.throttleBaseDelayMs ?? 1200,
        throttleMaxWaitMs: defaults.throttleMaxWaitMs ?? 10_000,
        webFallback,
        getWeb: defaults.getWeb,
        fetchImpl: defaults.fetchImpl,
        ...options,
      });
    },
  };
}
