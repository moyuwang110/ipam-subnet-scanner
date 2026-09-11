// Static checks for the browser bundle: ensures escapeHtml uses correct
// HTML entity replacements and no innerHTML template injects untrusted
// server-controlled values without escaping.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_JS = path.resolve(__dirname, '..', 'public', 'assets', 'app.js');
const INDEX_HTML = path.resolve(__dirname, '..', 'public', 'index.html');
const STYLES_CSS = path.resolve(__dirname, '..', 'public', 'assets', 'styles.css');

describe('app.js static checks', () => {
  it('escapeHtml encodes & < > " and \' using HTML entities', async () => {
    const src = await fs.readFile(APP_JS, 'utf-8');
    // The replacement map must produce the named/numeric entities for the
    // five HTML-sensitive characters.
    assert.match(src, /\.replaceAll\(['"]&['"],\s*['"]&amp;['"]\)/, '& must map to &amp;');
    assert.match(src, /\.replaceAll\(['"]<['"],\s*['"]&lt;['"]\)/, '< must map to &lt;');
    assert.match(src, /\.replaceAll\(['"]>['"],\s*['"]&gt;['"]\)/, '> must map to &gt;');
    assert.match(src, /\.replaceAll\(['"]"['"],\s*['"]&quot;['"]\)/, '" must map to &quot;');
    // Match the single-quote replacement using the exact JS literal in source.
    assert.ok(src.includes("replaceAll(\"'\", '&#39;')") || src.includes("replaceAll(\"'\", \"&#39;\")"), "' must map to &#39;");
    // The buggy self-mappings must not be present.
    assert.doesNotMatch(src, /replaceAll\(['"]&['"],\s*['"]&['"]\)/, '& must not map to itself');
    assert.doesNotMatch(src, /replaceAll\(['"]<['"],\s*['"]<['"]\)/, '< must not map to itself');
  });

  it('server-controlled identifiers injected into HTML attributes are escaped', async () => {
    const src = await fs.readFile(APP_JS, 'utf-8');
    // The subnet id is server-supplied and should not be dropped into a
    // template literal attribute via raw interpolation. The subnet switcher
    // options are the attribute-bounded surface for it now.
    assert.match(src, /value="\$\{escapeAttr\(s\.subnet\.id\)\}"/, 'switcher option value must use escapeAttr');
    // The status attribute is a fixed enum, but we sanity-check the home
    // template still routes all dynamic user-supplied text through escapeHtml.
    const homeBlock = src.match(/async function renderHome[\s\S]*?\/\/ ---- Subnet form/);
    assert.ok(homeBlock, 'home block should be present');
    assert.match(src, /escapeHtml\(detail\.name\)/);
    assert.match(src, /escapeHtml\(detail\.cidr\)/);
  });

  it('user-visible strings are localised to Chinese', async () => {
    const src = await fs.readFile(APP_JS, 'utf-8');
    // Status labels in the UI must be Chinese. The API still uses the
    // English keys (used/free/unknown/conflict), so the labels are mapped.
    assert.match(src, /used:\s*'已用'/);
    assert.match(src, /free:\s*'空闲'/);
    assert.match(src, /unknown:\s*'未知'/);
    assert.match(src, /conflict:\s*'冲突'/);
    // Top-level copy the user sees: title, navigation, buttons, empty state.
    assert.match(src, /<h2>子网总览</);
    assert.match(src, /\+ 新建子网/);
    assert.match(src, /正在加载…/);
    assert.match(src, /确定要删除该子网及其历史记录吗/);
    assert.match(src, /上次扫描失败：/);
    assert.match(src, /立即扫描/);
    // Tooltip fields should be Chinese and the dynamic values escaped.
    assert.match(src, /<dt>MAC 地址<\/dt><dd>\$\{escapeHtml\(r\.mac/);
    assert.match(src, /<dt>开放端口<\/dt><dd>\$\{r\.openPorts/);
    assert.match(src, /<dt>响应时间<\/dt><dd>\$\{r\.responseMs/);
  });

  it('subnet management is integrated into the home view (no dedicated list page)', async () => {
    const src = await fs.readFile(APP_JS, 'utf-8');
    assert.doesNotMatch(src, /renderSubnetList/, 'dedicated list page must be removed');
    // Detail header exposes create + delete actions directly.
    assert.match(src, /href="#\/subnets\/new">\+ 新建子网</);
    assert.match(src, /id="btn-delete"/);
    // Deleting returns to home and clears the remembered subnet.
    assert.match(src, /readLastSubnetId\(\) === detail\.id\) saveLastSubnetId\(null\)/);
    // Old list route falls back to home.
    assert.match(src, /parts\[0\] === 'subnets' && parts\.length === 1\) return renderHome\(\)/);
  });

  it('home shows a single subnet with a switcher (no dashboard cards)', async () => {
    const src = await fs.readFile(APP_JS, 'utf-8');
    // The dashboard card page is gone; home renders one subnet directly.
    assert.doesNotMatch(src, /renderDashboard/, 'dashboard must be removed');
    assert.match(src, /async function renderHome\(/);
    assert.match(src, /id="subnet-switch"/, 'subnet switcher must exist');
    assert.match(src, /ipam\.lastSubnet/, 'last-viewed subnet must be remembered');
    // Switching navigates to the chosen subnet.
    assert.match(src, /navigate\(`#\/subnets\/\$\{encodeURIComponent\(nextId\)\}`\)/);
  });

  it('scan polling does not re-render while idle (flicker fix)', async () => {
    const src = await fs.readFile(APP_JS, 'utf-8');
    const pollerBlock = src.match(/function startScanPolling\([\s\S]*?\n\}/);
    assert.ok(pollerBlock, 'startScanPolling should be present');
    // Re-render must be gated on having observed a running scan; idle polls
    // stop silently instead of rebuilding the page every second.
    assert.match(pollerBlock![0], /sawRunning/, 'poller must track running state');
    assert.match(pollerBlock![0], /if \(sawRunning\) renderSubnetDetail\(id\)/, 'refresh only after a scan finishes');
    // Progress updates must be in-place, not a full re-render.
    assert.match(pollerBlock![0], /#scan-bar/);
    assert.doesNotMatch(pollerBlock![0], /renderGrid|view\.innerHTML/);
  });

  it('theme switching reads/writes localStorage and toggles data-theme', async () => {
    const src = await fs.readFile(APP_JS, 'utf-8');
    assert.match(src, /localStorage\.getItem\(THEME_KEY\)/);
    assert.match(src, /localStorage\.setItem\(THEME_KEY,\s*next\)/);
    assert.match(src, /document\.documentElement\.setAttribute\('data-theme',\s*resolved\)/);
    assert.match(src, /prefers-color-scheme: light/);
    // Toggle button binding lives in index.html
    const html = await fs.readFile(INDEX_HTML, 'utf-8');
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /aria-label="切换暗色或亮色主题"/);
  });

  it('styles.css defines both light and dark themes', async () => {
    const css = await fs.readFile(STYLES_CSS, 'utf-8');
    assert.match(css, /\[data-theme="dark"\]/);
    assert.match(css, /\[data-theme="light"\]/);
    // Status markers should not rely on colour alone.
    assert.match(css, /badge\[data-status="used"\]::before/);
    assert.match(css, /badge\[data-status="conflict"\]::before/);
  });

  it('api() only sets Content-Type when a body is present (empty-body POST bug)', async () => {
    const src = await fs.readFile(APP_JS, 'utf-8');
    const apiBlock = src.match(/async function api\([\s\S]*?\n\}/);
    assert.ok(apiBlock, 'api() should be present');
    // The header must be gated on a body existing; otherwise bodyless POSTs
    // (scan/toggle) hit Fastify's FST_ERR_CTP_EMPTY_JSON_BODY rejection.
    assert.match(apiBlock![0], /opts\.body !== undefined/, 'Content-Type must be gated on body presence');
    assert.doesNotMatch(
      apiBlock![0],
      /headers:\s*\{\s*'Content-Type':\s*'application\/json'\s*\},\s*\.\.\.options/,
      'must not unconditionally send Content-Type for every request',
    );
  });

  it('index.html exposes a Chinese aria-label and lang attribute', async () => {
    const html = await fs.readFile(INDEX_HTML, 'utf-8');
    assert.match(html, /<html lang="zh-CN"/);
    assert.match(html, /aria-label="IPAM 主页"/);
    // The dedicated subnet-list nav entry is gone (management lives on home).
    assert.doesNotMatch(html, /#\/subnets">子网管理</);
  });
});
