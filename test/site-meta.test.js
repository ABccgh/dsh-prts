/**
 * 站点元数据缓存（`lib/site-meta.js`）的离线测试：10 分钟 TTL、`fresh` 绕过、
 * 失败时沿用旧值、命名空间索引随 meta 返回。
 *
 * @module dsh-prts/test/site-meta
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SITE_META_TTL_MS, createSiteMeta } from '../lib/site-meta.js';
import { createSite } from '../lib/sites.js';
import { SITEINFO } from './fixtures/fixtures.js';

/** 假 reader：记录每次请求，可切换成失败。 */
function fakeReader() {
  const calls = [];
  let failing = false;
  return {
    calls,
    fail(value) {
      failing = value;
    },
    async read(url, options = {}) {
      calls.push({ url, fresh: options.fresh === true });
      if (failing) return { ok: false, error: '网络错误' };
      return { ok: true, data: SITEINFO, via: 'http', attempts: 1, server: 'Tengine' };
    },
  };
}

test('siteinfo 缓存 10 分钟：TTL 内命中，过期重取', async () => {
  assert.equal(SITE_META_TTL_MS, 600_000);
  let clock = 0;
  const reader = fakeReader();
  const siteMeta = createSiteMeta(reader, { now: () => clock });
  const site = createSite({});

  const first = await siteMeta.get(site);
  assert.equal(reader.calls.length, 1);
  assert.equal(first.sitename, 'PRTS');
  assert.equal(first.namespaceIds['模板'], 10, 'meta 里要带命名空间名字 → id 索引');

  clock = SITE_META_TTL_MS - 1;
  await siteMeta.get(site);
  assert.equal(reader.calls.length, 1, 'TTL 内应命中缓存');

  clock = SITE_META_TTL_MS + 1;
  await siteMeta.get(site);
  assert.equal(reader.calls.length, 2, '超过 10 分钟应重新请求');
});

test('fresh: true 绕过 siteinfo 缓存并刷新', async () => {
  let clock = 0;
  const reader = fakeReader();
  const siteMeta = createSiteMeta(reader, { now: () => clock });
  const site = createSite({});
  await siteMeta.get(site);
  clock += 1000;
  await siteMeta.get(site, { fresh: true });
  assert.equal(reader.calls.length, 2);
  assert.equal(reader.calls[1].fresh, true);
  // fresh 之后缓存被刷新，TTL 内继续命中
  clock += 1000;
  await siteMeta.get(site);
  assert.equal(reader.calls.length, 2);
});

test('siteinfo 失败时沿用旧值，且不把失败写进缓存', async () => {
  let clock = 0;
  const reader = fakeReader();
  const siteMeta = createSiteMeta(reader, { now: () => clock });
  const site = createSite({});
  await siteMeta.get(site);

  clock = SITE_META_TTL_MS + 1;
  reader.fail(true);
  const stale = await siteMeta.get(site);
  assert.ok(stale !== undefined, '过期失败应沿用旧值');
  assert.equal(stale.namespaceIds['模板'], 10);
  assert.equal(reader.calls.length, 2);

  reader.fail(false);
  clock += 1;
  const refreshed = await siteMeta.get(site);
  assert.equal(refreshed.namespaceIds['模板'], 10);
  assert.equal(reader.calls.length, 3, '失败没有写缓存，下一次要重试');
});
