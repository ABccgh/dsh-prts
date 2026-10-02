/**
 * 出网层离线测试：拦截页识别、退避重试、证书、兜底通道与错误文案。
 *
 * 全部用例把 `throttleBaseDelayMs` 设成 0，重试是瞬时的，不拖慢测试。
 *
 * @module dsh-prts/test/http
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpClient,
  explainHttpStatus,
  fetchJson,
  hintForCode,
  isCertificateError,
  isRetryableStatus,
  isUnexpectedHtmlBody,
  unexpectedBodyMessage,
} from '../lib/http.js';
import { THROTTLE_BARE_NUMBER, THROTTLE_HTML } from './fixtures/fixtures.js';

const URL_UNDER_TEST = 'https://prts.wiki/api.php?action=query&meta=siteinfo&format=json';

/** 构造一个 JSON 响应。 */
function jsonResponse(data, { status = 200, server = 'nginx' } = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', server } });
}

/** 构造一个 HTML 响应（拦截页）。 */
function htmlResponse(body = THROTTLE_HTML, { status = 567, server = 'CDN' } = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8', server } });
}

/** 构造 undici 风格的三层嵌套网络错误。 */
function networkError(code, message = 'fetch failed') {
  const error = new Error(message);
  error.cause = Object.assign(new Error(`connect ${code}`), { code });
  return error;
}

/** 按顺序作答的假 fetch。 */
function scriptedFetch(steps) {
  let index = 0;
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    const value = typeof step === 'function' ? step(index) : step;
    // 同一个 Response 只能读一次 body：复用最后一步时要给新的。
    if (value instanceof Response) return value.clone();
    return value;
  };
  return { impl, calls };
}

const FAST = { throttleBaseDelayMs: 0, throttleAttempts: 3, webFallback: false };

test('isUnexpectedHtmlBody：HTML 与纯数字算异常，JSON 不算', () => {
  assert.equal(isUnexpectedHtmlBody(new Response('<html>', { headers: { 'content-type': 'text/html' } }), THROTTLE_HTML), true);
  assert.equal(isUnexpectedHtmlBody(new Response('{}', { headers: { 'content-type': 'application/json' } }), '{"a":1}'), false);
  assert.equal(isUnexpectedHtmlBody(new Response('x', { headers: { 'content-type': 'text/plain' } }), THROTTLE_BARE_NUMBER), true);
  assert.equal(isUnexpectedHtmlBody(new Response('x', { headers: {} }), '  [1,2]'), false);
});

test('isRetryableStatus：567/429/5xx 重试，400/404 不重试', () => {
  assert.equal(isRetryableStatus(567), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(403, 500), true);
});

test('explainHttpStatus / hintForCode 的文案指向可执行动作', () => {
  assert.ok(explainHttpStatus(567).includes('CDN'));
  assert.ok(explainHttpStatus(567).includes('重试'));
  assert.ok(explainHttpStatus(400).includes('参数'));
  assert.ok(explainHttpStatus(404).includes('/api.php'));
  assert.ok(explainHttpStatus(566).includes('5xx'));
  assert.equal(explainHttpStatus(200), '');
  assert.ok(hintForCode('ECONNREFUSED').includes('加速'));
  assert.ok(hintForCode('ECONNRESET').includes('重试'));
  assert.equal(hintForCode('WHATEVER'), '');
  assert.equal(isCertificateError(networkError('SELF_SIGNED_CERT_IN_CHAIN')), true);
  assert.equal(isCertificateError(networkError('ECONNRESET')), false);
});

test('unexpectedBodyMessage 带上状态、server、尝试次数与后续动作', () => {
  const text = unexpectedBodyMessage({ url: URL_UNDER_TEST, status: 567, server: 'CDN', attempts: 3, userAgent: 'ua' });
  assert.ok(text.includes('567'));
  assert.ok(text.includes('CDN'));
  assert.ok(text.includes('已尝试 3 次'));
  assert.ok(text.includes('稍后重试'));
});

test('fetchJson：先 567 再 200 → 重试后成功并记下尝试次数', async () => {
  const { impl, calls } = scriptedFetch([htmlResponse(), jsonResponse({ ok: 1 })]);
  const result = await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: impl });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.data.ok, 1);
  assert.equal(calls.length, 2);
});

test('fetchJson：HTTP 200 + HTML 空壳 / 纯数字同样重试', async () => {
  const shell = scriptedFetch([htmlResponse(THROTTLE_HTML, { status: 200 }), jsonResponse({ ok: 2 })]);
  assert.equal((await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: shell.impl })).ok, true);

  const bare = scriptedFetch([
    new Response(THROTTLE_BARE_NUMBER, { status: 200, headers: { 'content-type': 'text/plain' } }),
    jsonResponse({ ok: 3 }),
  ]);
  const result = await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: bare.impl });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test('fetchJson：一直 567 → 用尽次数后给出可执行错误', async () => {
  const { impl, calls } = scriptedFetch([htmlResponse()]);
  const result = await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.status, 567);
  assert.ok(result.error.includes('567'));
  assert.ok(result.hint.includes('重试'));
  assert.equal(calls.length, 3);
});

test('fetchJson：一直返回 HTML 空壳 → 错误指向 CDN 拦截而非配置', async () => {
  const { impl } = scriptedFetch([htmlResponse(THROTTLE_HTML, { status: 200 })]);
  const result = await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.unexpectedBody, true);
  assert.ok(result.error.includes('已尝试 3 次'));
});

test('fetchJson：5xx 与 429 重试，400 不重试', async () => {
  const failing = scriptedFetch([jsonResponse({}, { status: 503 }), jsonResponse({ ok: 4 })]);
  assert.equal((await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: failing.impl })).ok, true);

  const limited = scriptedFetch([
    new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } }),
    jsonResponse({ ok: 5 }),
  ]);
  assert.equal((await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: limited.impl })).ok, true);

  const bad = scriptedFetch([jsonResponse({}, { status: 400 })]);
  const badResult = await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: bad.impl });
  assert.equal(badResult.ok, false);
  assert.equal(badResult.attempts, 1);
  assert.ok(badResult.hint.includes('参数'));
});

test('fetchJson：网络错误给出错误码与建议，并尊重总等待上限', async () => {
  const { impl, calls } = scriptedFetch([networkError('ECONNREFUSED')]);
  const result = await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ECONNREFUSED');
  assert.ok(result.hint.includes('加速'));
  assert.equal(calls.length, 3);

  const capped = scriptedFetch([networkError('ECONNRESET')]);
  const once = await fetchJson(URL_UNDER_TEST, {
    fetchImpl: capped.impl, webFallback: false, throttleAttempts: 5, throttleBaseDelayMs: 300, throttleMaxWaitMs: 400,
  });
  assert.equal(once.ok, false);
  assert.ok(capped.calls.length < 5, `总等待上限应压住重试次数，实际 ${capped.calls.length} 次`);
});

test('fetchJson：超时归一成 ETIMEDOUT；证书错误给证书建议；取消直接返回', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const timed = await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: scriptedFetch([timeout]).impl, timeoutMs: 1234 });
  assert.equal(timed.code, 'ETIMEDOUT');
  assert.ok(timed.error.includes('1234'));

  const cert = await fetchJson(URL_UNDER_TEST, {
    ...FAST, fetchImpl: scriptedFetch([networkError('SELF_SIGNED_CERT_IN_CHAIN')]).impl, trustSystemCa: 'never',
  });
  assert.equal(cert.code, 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.ok(cert.hint.includes('证书'));

  const controller = new AbortController();
  controller.abort();
  const aborted = scriptedFetch([jsonResponse({})]);
  const cancelled = await fetchJson(URL_UNDER_TEST, { ...FAST, fetchImpl: aborted.impl, signal: controller.signal });
  assert.equal(cancelled.aborted, true);
  assert.equal(aborted.calls.length, 0);
});

test('fetchJson：直连全失败时改用 DSH web 兜底并标出通道', async () => {
  const { impl } = scriptedFetch([htmlResponse()]);
  const webCalls = [];
  const result = await fetchJson(URL_UNDER_TEST, {
    ...FAST,
    webFallback: true,
    fetchImpl: impl,
    getWeb: () => ({
      async fetch({ url }) {
        webCalls.push(url);
        return { statusCode: 200, body: { content: JSON.stringify({ ok: 9 }) } };
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'dsh-web');
  assert.equal(result.data.ok, 9);
  assert.equal(webCalls.length, 1);

  const notJson = await fetchJson(URL_UNDER_TEST, {
    ...FAST, webFallback: true, fetchImpl: scriptedFetch([htmlResponse()]).impl,
    getWeb: () => ({ async fetch() { return { statusCode: 200, body: { content: '<html>还是空壳</html>' } }; } }),
  });
  assert.equal(notJson.ok, false);
  assert.ok(notJson.error.includes('仍拿不到 JSON'));

  let touched = false;
  await fetchJson(URL_UNDER_TEST, {
    ...FAST, webFallback: false, fetchImpl: scriptedFetch([htmlResponse()]).impl,
    getWeb: () => ({ async fetch() { touched = true; return {}; } }),
  });
  assert.equal(touched, false);
});

test('createHttpClient：默认值可被单次调用覆盖', async () => {
  const { impl, calls } = scriptedFetch([jsonResponse({ ok: 1 })]);
  const client = createHttpClient({ fetchImpl: impl, timeoutMs: 5000, userAgent: 'ua-test', throttleBaseDelayMs: 0, webFallback: false });
  assert.equal(client.timeoutMs, 5000);
  assert.equal(client.userAgent, 'ua-test');
  const result = await client.json(URL_UNDER_TEST);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});
