/**
 * 清单与显示资源契约（PRTS）。
 *
 * 对应 DSH 0.2.2 的 bundle 显示规则：标题/描述来自导出的 locale JSON，图标来自
 * `./icon`，README 是插件详情页的回落文档。
 *
 * @module dsh-prts/test/manifest
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../lib/index.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const MAX_ICON_BYTES = 256 * 1024;

test('清单：名字、版本与补丁文件', () => {
  assert.equal(manifest.name, '@local/prts');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, manifest.dsh.bundle.patch)));
});

test('显示资源：locale 与 icon 都已导出并列入 files', () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  for (const entry of ['lib/**/*.js', 'locale/*.json', 'icon.svg', 'cordis.patch.yml', 'README.md']) {
    assert.ok(manifest.files.includes(entry), `files 缺少 ${entry}`);
  }
});

test('locale：中英文都有标题与描述', () => {
  for (const language of ['en', 'zh']) {
    const file = path.join(REPO_ROOT, 'locale', `${language}.json`);
    assert.ok(fs.existsSync(file), `缺少 ${language}.json`);
    const locale = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(typeof locale.meta?.title === 'string' && locale.meta.title !== '', `${language} 缺 title`);
    assert.ok(typeof locale.meta?.description === 'string' && locale.meta.description.length > 20, `${language} 描述太短`);
    if (locale.meta.detail !== undefined) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, locale.meta.detail)), `${language} 的 meta.detail 指向不存在的文件`);
    }
  }
});

test('图标：36×36 透明底、自包含、无文字与脚本、体积达标', () => {
  const file = path.join(REPO_ROOT, 'icon.svg');
  const svg = fs.readFileSync(file, 'utf8');
  assert.ok(fs.statSync(file).size <= MAX_ICON_BYTES, '图标超过 256 KiB');
  assert.match(svg, /viewBox="0 0 36 36"/);
  for (const forbidden of ['<text', '<style', '<script', '<foreignObject', '<image', 'onload=', 'onclick=']) {
    assert.ok(!svg.includes(forbidden), `图标不应包含 ${forbidden}`);
  }
});

test('README 记录的版本与包版本一致', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(manifest.version), `README 未提到当前版本 ${manifest.version}`);
});

test('默认 User-Agent 带包版本与联系地址', () => {
  const ua = normalizeConfig({}).userAgent;
  assert.ok(ua.includes(manifest.version), `UA 应带版本 ${manifest.version}：${ua}`);
  assert.match(ua, /\+https?:\/\//, 'UA 必须带联系地址');
});
