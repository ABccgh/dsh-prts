/**
 * 工具层共用件的离线测试：命名空间解析、接口警告、续取 token、尾注、工具超时。
 *
 * 这几项都是「参数静默失效」类缺陷的防线：MediWiki 对不认识的命名空间名字、
 * 不认的 continue 字段不会报错，只会忽略或返回空——必须由工具层自己把关。
 *
 * @module dsh-prts/test/shared
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapSiteInfo } from '../lib/mediawiki.js';
import {
  CONTINUE_KEYS, TOOL_TIMEOUT_MS, apiWarningText, continueTokenText, listTail, parseContinueToken, resolveNamespace,
} from '../lib/tools/shared.js';
import { SITEINFO } from './fixtures/fixtures.js';

const meta = mapSiteInfo(SITEINFO);

test('TOOL_TIMEOUT_MS：每个工具的兜底超时是 90 秒', () => {
  assert.equal(TOOL_TIMEOUT_MS, 90_000);
});

test('resolveNamespace：名字 / 别名 / canonical / 数字 id / * 都能解析', () => {
  assert.deepEqual(resolveNamespace(meta, '模板'), { ns: 10, label: '模板' });
  assert.deepEqual(resolveNamespace(meta, '分类'), { ns: 14, label: '分类' });
  assert.deepEqual(resolveNamespace(meta, 'Category'), { ns: 14, label: '分类' });
  assert.deepEqual(resolveNamespace(meta, 'template'), { ns: 10, label: '模板' }, 'canonical 名不区分大小写');
  assert.deepEqual(resolveNamespace(meta, '媒体文件'), { ns: -2, label: '媒体' }, '别名表也要认');
  assert.deepEqual(resolveNamespace(meta, ' 模板: '), { ns: 10, label: '模板' }, '末尾冒号与空白可省');
  assert.deepEqual(resolveNamespace(meta, '14'), { ns: 14, label: '分类' });
  assert.deepEqual(resolveNamespace(meta, 274), { ns: 274, label: '微件' });
  assert.deepEqual(resolveNamespace(meta, '*'), { ns: '*', label: '全部' });
  assert.deepEqual(resolveNamespace(meta, 'ALL'), { ns: '*', label: '全部' });
  assert.deepEqual(resolveNamespace(meta, undefined), { ns: 0, label: '主条目' });
  assert.deepEqual(resolveNamespace(meta, ''), { ns: 0, label: '主条目' });
  assert.deepEqual(resolveNamespace(meta, undefined, '*'), { ns: '*', label: '全部' });
});

test('resolveNamespace：不认识的名字 / id 抛可执行错误', () => {
  assert.throws(() => resolveNamespace(meta, '不存在的命名空间'), /不认识的命名空间/);
  assert.throws(() => resolveNamespace(meta, '不存在的命名空间'), /模板（10）/);
  assert.throws(() => resolveNamespace(meta, '9999'), /命名空间 id 9999 不存在/);
  assert.throws(() => resolveNamespace(undefined, '模板'), /siteinfo/);
  // siteinfo 拿不到时数字 id 仍可用（标签退化到内置表）
  assert.deepEqual(resolveNamespace(undefined, '10'), { ns: 10, label: '模板' });
});

test('apiWarningText：把 warnings 渲染成可见警告行（形状兼容）', () => {
  assert.equal(apiWarningText({}, '检索'), '');
  assert.equal(apiWarningText(undefined, '检索'), '');
  assert.equal(
    apiWarningText({ warnings: { search: { warnings: 'Unrecognized value for parameter "srnamespace"' } } }, '检索'),
    '⚠ 检索：接口警告「Unrecognized value for parameter "srnamespace"」',
  );
  const nested = apiWarningText({ warnings: { query: { '*': '第一条' }, other: ['第二条', '第一条'] } }, '读取出链');
  assert.ok(nested.includes('第一条') && nested.includes('第二条'), nested);
  assert.equal(nested.split('\n').length, 2, '同一条警告不重复打印');
  assert.ok(apiWarningText({ warnings: '直接字符串' }, '标题候选').includes('直接字符串'));
});

test('parseContinueToken：JSON 完整 token / 裸 token / 白名单过滤与报错', () => {
  assert.equal(parseContinueToken(undefined, 'search'), undefined);
  assert.equal(parseContinueToken('  ', 'search'), undefined);
  assert.deepEqual(
    parseContinueToken('{"cmcontinue":"page|1","continue":"-||","evil":"x"}', 'categorymembers'),
    { cmcontinue: 'page|1', continue: '-||' },
    '只放行白名单字段',
  );
  assert.deepEqual(parseContinueToken('page|417263686572', 'categorymembers'), { cmcontinue: 'page|417263686572' });
  assert.deepEqual(parseContinueToken('20', 'search'), { sroffset: '20' });
  assert.deepEqual(
    parseContinueToken('{"blcontinue":"9","eicontinue":"0|1","continue":"-||"}', ['blcontinue', 'eicontinue', 'continue']),
    { blcontinue: '9', eicontinue: '0|1', continue: '-||' },
    'prts_links 的 in 方向两组一起回传',
  );
  assert.throws(() => parseContinueToken('{not json', 'search'), /continue 参数格式不对/);
  assert.throws(() => parseContinueToken('{"evil":"x"}', 'search'), /没有任何可用的续取字段/);
});

test('continueTokenText：把响应里的 continue 序列化成下一次可回传的 token', () => {
  assert.equal(
    continueTokenText({ continue: { cmcontinue: 'a', continue: '-||', other: 1 } }, 'categorymembers'),
    JSON.stringify({ cmcontinue: 'a', continue: '-||' }),
  );
  assert.equal(continueTokenText({}, 'search'), '');
  assert.equal(continueTokenText(undefined, 'search'), '');
  assert.equal(
    continueTokenText(
      [{ continue: { blcontinue: '1' } }, { continue: { eicontinue: '2', continue: '-||' } }],
      ['blcontinue', 'eicontinue', 'continue'],
    ),
    JSON.stringify({ blcontinue: '1', eicontinue: '2', continue: '-||' }),
    '两个列表的 token 合并成一个',
  );
  assert.ok(CONTINUE_KEYS.embeddedin.includes('eicontinue'));
});

test('listTail：统一尾注，不再出现「共 N 条 + 还有更多」自相矛盾', () => {
  assert.equal(
    listTail(3, 85, '个页面', '还有更多，继续取下一页：continue=…'),
    '\n（共 85 个页面，本次显示 3 条；还有更多，继续取下一页：continue=…）',
  );
  assert.equal(listTail(3, null, '个页面'), '\n（本次显示 3 个页面，已到末尾）');
  assert.equal(listTail(0, 0, '个成员'), '\n（共 0 个成员，本次显示 0 条，已到末尾）');
});
