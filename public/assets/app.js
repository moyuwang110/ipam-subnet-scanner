// Minimal hash-router SPA written in TypeScript-transpiled-in-mind JS.
// We compile via tsc (already in the build), so this file is plain ES2022.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// 中文用户可见文案集中在此处。API 返回的状态值（used/free/unknown/conflict）保持英文。
const STATUS_LABEL = {
  used: '已用',
  free: '空闲',
  unknown: '未知',
  conflict: '冲突',
};
const STATUS_LABEL_FULL = {
  used: '已使用',
  free: '空闲',
  unknown: '未知',
  conflict: '冲突',
};
const STATUS_ICON = {
  used: '●',
  free: '·',
  unknown: '?',
  conflict: '!',
};
const SCAN_STATUS_LABEL = {
  pending: '待扫描',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
};

const state = {
  view: null,
  cache: { subnets: null },
  scanPollers: new Map(),
};

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Strict attribute-value escaping. Same encoding as escapeHtml() but quotes
// single quotes only as &#39; and double quotes as &quot; — sufficient for any
// HTML attribute context. Used for dynamic values injected via template
// attributes (e.g. data-*, href).
function escapeAttr(s) {
  return escapeHtml(s);
}

function notice(text, kind = 'error') {
  return `<div class="notice ${kind}" role="alert">${escapeHtml(text)}</div>`;
}

async function api(path, options = {}) {
  // 只在真正携带 body 时才发送 Content-Type: application/json。
  // 无 body 的 POST/DELETE 若带上该头，Fastify 会因空 JSON body 拒绝请求
  // （FST_ERR_CTP_EMPTY_JSON_BODY: "Body cannot be empty..."）。
  const opts = { ...options };
  if (opts.body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body?.message || body?.error || res.statusText);
    err.status = res.status;
    err.code = body?.error;
    err.body = body;
    throw err;
  }
  return body;
}

// ---- Theme handling ----
const THEME_KEY = 'ipam.theme';
function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}
function readStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}
function applyTheme(theme) {
  const resolved = theme || systemTheme();
  document.documentElement.setAttribute('data-theme', resolved);
  const btn = $('#theme-toggle');
  if (btn) {
    const isLight = resolved === 'light';
    btn.setAttribute('aria-pressed', String(isLight));
    btn.setAttribute(
      'aria-label',
      isLight ? '切换到暗色主题（当前：亮色）' : '切换到亮色主题（当前：暗色）',
    );
    btn.setAttribute('title', isLight ? '切换到暗色主题' : '切换到亮色主题');
    const icon = btn.querySelector('.theme-icon');
    const label = btn.querySelector('.theme-label');
    if (icon) {
      icon.dataset.icon = isLight ? 'sun' : 'moon';
      icon.textContent = isLight ? '☀' : '☾';
    }
    if (label) label.textContent = isLight ? '亮色' : '暗色';
  }
}
function initTheme() {
  const stored = readStoredTheme();
  applyTheme(stored);
  const btn = $('#theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      const next = current === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // ignore quota/disabled storage; theme still applies for this session.
      }
      applyTheme(next);
    });
  }
  // Follow the OS when the user has not made an explicit choice.
  if (!stored && window.matchMedia) {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const listener = (e) => {
      if (!readStoredTheme()) applyTheme(e.matches ? 'light' : 'dark');
    };
    if (mql.addEventListener) mql.addEventListener('change', listener);
    else if (mql.addListener) mql.addListener(listener);
  }
}

function router() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  stopAllPollers();
  if (parts.length === 0) return renderHome();
  if (parts[0] === 'subnets' && parts.length === 1) return renderHome();
  if (parts[0] === 'subnets' && parts[1] === 'new') return renderSubnetForm();
  if (parts[0] === 'subnets' && parts[2] === 'edit') return renderSubnetForm(parts[1]);
  if (parts[0] === 'subnets' && parts.length >= 2) return renderSubnetDetail(parts[1]);
  return renderHome();
}

function navigate(hash) {
  if (location.hash === hash) router();
  else location.hash = hash;
}

window.addEventListener('hashchange', router);

function setStatus(msg) {
  const el = $('#global-status');
  if (el) el.textContent = msg ?? '';
}

function stopAllPollers() {
  for (const stop of state.scanPollers.values()) clearInterval(stop);
  state.scanPollers.clear();
}

// ---- 主页：展示单个子网，可通过切换器换到其他子网 ----

const LAST_SUBNET_KEY = 'ipam.lastSubnet';
function readLastSubnetId() {
  try {
    return localStorage.getItem(LAST_SUBNET_KEY);
  } catch {
    return null;
  }
}
function saveLastSubnetId(id) {
  try {
    if (id) localStorage.setItem(LAST_SUBNET_KEY, id);
    else localStorage.removeItem(LAST_SUBNET_KEY);
  } catch {
    // ignore quota/disabled storage
  }
}

async function renderHome(preferredId) {
  const view = $('#view');
  view.innerHTML = `<div class="card"><h2>子网总览</h2><div class="empty">正在加载…</div></div>`;
  let subnets;
  try {
    const data = await api('/api/subnets');
    subnets = data.subnets;
    state.cache.subnets = subnets;
  } catch (err) {
    view.innerHTML = `<div class="card">${notice(err.message)}</div>`;
    return;
  }
  if (subnets.length === 0) {
    view.innerHTML = `
      <div class="card">
        <h2>子网总览</h2>
        <p class="empty">暂无子网。点击 <a href="#/subnets/new">新建子网</a> 开始管理。</p>
      </div>`;
    return;
  }
  // 优先使用路由指定的子网，其次恢复上次查看的子网，否则选第一个。
  const wanted = preferredId ?? readLastSubnetId();
  const target = subnets.find((s) => s.subnet.id === wanted)?.subnet ?? subnets[0].subnet;
  await renderSubnetDetail(target.id);
}

// ---- Subnet form (create / edit) ----
// 管理操作（新建/编辑/启停/删除）直接集成在主页的子网视图中，
// 不再提供独立的子网列表页。

async function renderSubnetForm(id) {
  const view = $('#view');
  let subnet = { name: '', cidr: '', description: '', enabled: true };
  if (id) {
    try {
      const data = await api(`/api/subnets/${encodeURIComponent(id)}`);
      subnet = data.subnet;
    } catch (err) {
      view.innerHTML = `<div class="card">${notice(err.message)}</div>`;
      return;
    }
  }
  view.innerHTML = `
    <div class="card">
      <div class="view-header">
        <h2>${id ? '编辑子网' : '新建子网'}</h2>
        <div class="spacer"></div>
        <a class="btn secondary" href="${id ? `#/subnets/${encodeURIComponent(id)}` : '#/'}">返回</a>
      </div>
      <form id="subnet-form" novalidate>
        <div id="form-error"></div>
        <div class="field">
          <label for="f-name">名称 <span class="muted">（必填）</span></label>
          <input id="f-name" name="name" required maxlength="64" placeholder="例如：办公网段" value="${escapeHtml(subnet.name)}" />
        </div>
        <div class="field">
          <label for="f-cidr">CIDR <span class="muted">（必填，例如 192.168.10.0/24）</span></label>
          <input id="f-cidr" name="cidr" required pattern="^[0-9.]+/[0-9]{1,2}$" placeholder="192.168.10.0/24" value="${escapeHtml(subnet.cidr)}" />
        </div>
        <div class="field">
          <label for="f-desc">描述</label>
          <textarea id="f-desc" name="description" rows="3" placeholder="可选：用途、位置、负责人等备注信息">${escapeHtml(subnet.description ?? '')}</textarea>
        </div>
        <div class="row">
          <button type="submit" class="btn">${id ? '保存修改' : '创建子网'}</button>
          <a class="btn secondary" href="${id ? `#/subnets/${encodeURIComponent(id)}` : '#/'}">取消</a>
        </div>
      </form>
    </div>`;
  $('#subnet-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#form-error');
    errEl.innerHTML = '';
    const name = $('#f-name').value.trim();
    const cidr = $('#f-cidr').value.trim();
    const description = $('#f-desc').value.trim();
    if (!name) {
      errEl.innerHTML = notice('请填写子网名称');
      return;
    }
    if (!cidr) {
      errEl.innerHTML = notice('请填写 CIDR 地址段');
      return;
    }
    const payload = { name, cidr, description };
    try {
      const path = id ? `/api/subnets/${encodeURIComponent(id)}` : '/api/subnets';
      const method = id ? 'PUT' : 'POST';
      const res = await api(path, { method, body: JSON.stringify(payload) });
      navigate(`#/subnets/${encodeURIComponent(res.subnet.id)}`);
    } catch (err) {
      errEl.innerHTML = notice(err.message);
    }
  });
}

// ---- Subnet detail ----

async function renderSubnetDetail(id) {
  const view = $('#view');
  view.innerHTML = `<div class="card"><h2>子网详情</h2><div class="empty">正在加载…</div></div>`;
  let data;
  let subnetList = [];
  try {
    const [d, l] = await Promise.all([
      api(`/api/subnets/${encodeURIComponent(id)}`),
      api('/api/subnets').catch(() => ({ subnets: [] })),
    ]);
    data = d;
    subnetList = l.subnets ?? [];
    state.cache.subnets = subnetList;
  } catch (err) {
    view.innerHTML = `<div class="card">${notice(err.message)}</div>`;
    return;
  }
  const { subnet, summary, totalAddresses, records, truncated } = data;
  let allRecords = records;
  if (truncated) {
    // For large subnets we page through /addresses to avoid loading every
    // record into memory at once. Cap the total we materialise client-side
    // to keep the UI responsive; further pages can be requested later via
    // the filter/search UI.
    const MAX_TOTAL = 4096;
    const PAGE = 1000;
    try {
      const collected = [...records];
      let offset = PAGE;
      while (collected.length < Math.min(totalAddresses, MAX_TOTAL)) {
        const page = await api(`/api/subnets/${encodeURIComponent(id)}/addresses?offset=${offset}&limit=${PAGE}`);
        if (!page.records || page.records.length === 0) break;
        collected.push(...page.records);
        if (page.records.length < PAGE) break;
        offset += PAGE;
      }
      allRecords = collected;
    } catch (err) {
      // ignore; use embedded subset
    }
  }
  const detail = {
    id: subnet.id,
    name: subnet.name,
    cidr: subnet.cidr,
    mask: subnet.mask,
    description: subnet.description ?? '',
    enabled: subnet.enabled,
    lastScanAt: subnet.lastScanAt,
    lastScanStatus: subnet.lastScanStatus,
    lastScanError: subnet.lastScanError,
    records: allRecords,
    summary,
    totalAddresses,
  };
  state.currentDetail = detail;
  saveLastSubnetId(id);
  drawDetail(view, detail, subnetList);
  startScanPolling(id);
}

function drawDetail(view, detail, subnetList = []) {
  const last = detail.lastScanAt ? new Date(detail.lastScanAt).toLocaleString() : '尚未扫描';
  const usage = detail.summary.total > 0 ? (detail.summary.used / detail.summary.total * 100).toFixed(1) : '0.0';
  const status = detail.lastScanStatus ?? 'pending';
  const stLabel = SCAN_STATUS_LABEL[status] ?? status;
  const lastLine = detail.lastScanAt
    ? `最近扫描：${escapeHtml(last)}（${escapeHtml(stLabel)}）`
    : `尚未扫描（${escapeHtml(stLabel)}）`;
  const switchOptions = subnetList
    .map((s) => `
      <option value="${escapeAttr(s.subnet.id)}"${s.subnet.id === detail.id ? ' selected' : ''}>
        ${escapeHtml(s.subnet.name)}（${escapeHtml(s.subnet.cidr)}）${s.subnet.enabled ? '' : ' · 已停用'}
      </option>`)
    .join('');
  view.innerHTML = `
    <div class="view-header">
      <label class="switch-label" for="subnet-switch">切换子网</label>
      <select id="subnet-switch" class="subnet-switch" aria-label="切换子网">${switchOptions}</select>
      <h2>${escapeHtml(detail.name)}</h2>
      <span class="badge" data-status="${detail.enabled ? 'used' : 'free'}">${detail.enabled ? '已启用' : '已停用'}</span>
      <span class="badge">${escapeHtml(detail.cidr)}</span>
      <span class="badge">掩码 ${escapeHtml(detail.mask)}</span>
      <div class="spacer"></div>
      <a class="btn secondary" href="#/subnets/new">+ 新建子网</a>
      <a class="btn secondary" href="#/subnets/${encodeURIComponent(detail.id)}/edit">编辑</a>
      <button class="btn secondary" id="btn-toggle">${detail.enabled ? '停用' : '启用'}</button>
      <button class="btn danger" id="btn-delete">删除</button>
      <button class="btn" id="btn-scan" ${(!detail.enabled || detail.isScanning) ? 'disabled' : ''}>${detail.isScanning ? '扫描中…' : '立即扫描'}</button>
    </div>
    <div class="card">
      <p>${detail.description ? escapeHtml(detail.description) : '<span class="muted">（暂无描述）</span>'}</p>
      <div class="summary">
        <div data-kind="total"><strong>${detail.summary.total}</strong><span>总数</span></div>
        <div data-kind="used"><strong>${detail.summary.used}</strong><span>已用</span></div>
        <div data-kind="free"><strong>${detail.summary.free}</strong><span>空闲</span></div>
        <div data-kind="unknown"><strong>${detail.summary.unknown}</strong><span>未知</span></div>
        <div data-kind="conflict"><strong>${detail.summary.conflict}</strong><span>冲突</span></div>
        <div data-kind="usage"><strong>${usage}%</strong><span>利用率</span></div>
      </div>
      <div id="scan-status">
        ${status === 'running' ? `<div id="scan-progress-text">扫描进行中，请稍候…</div><div class="progress" aria-label="扫描进度"><div id="scan-bar" style="width:0%"></div></div>` : ''}
        ${status === 'failed' ? notice('上次扫描失败：' + (detail.lastScanError ?? '未知原因')) : ''}
        <div class="muted">${lastLine}</div>
      </div>
    </div>
    <div class="card">
      <div class="toolbar">
        <label for="filter-status" style="margin:0">筛选状态：</label>
        <select id="filter-status" aria-label="按状态筛选地址">
          <option value="all">全部</option>
          <option value="used">已用</option>
          <option value="free">空闲</option>
          <option value="unknown">未知</option>
          <option value="conflict">冲突</option>
        </select>
        <input id="filter-q" placeholder="搜索 IP / MAC / 主机名" aria-label="搜索地址" style="max-width:280px" />
        <div class="spacer"></div>
        <span class="muted" id="grid-count" aria-live="polite"></span>
      </div>
      <div class="address-grid" id="address-grid" role="grid" aria-label="地址网格"></div>
      <div id="grid-empty" class="empty" hidden>没有匹配条件的地址。</div>
    </div>`;
  renderGrid(detail);

  const switcher = $('#subnet-switch');
  if (switcher) {
    switcher.addEventListener('change', () => {
      const nextId = switcher.value;
      if (!nextId || nextId === detail.id) return;
      saveLastSubnetId(nextId);
      navigate(`#/subnets/${encodeURIComponent(nextId)}`);
    });
  }

  $('#btn-toggle').addEventListener('click', async () => {
    try {
      await api(`/api/subnets/${encodeURIComponent(detail.id)}/toggle`, { method: 'POST' });
      renderSubnetDetail(detail.id);
    } catch (err) {
      view.innerHTML = `<div class="card">${notice(err.message)}</div>`;
    }
  });
  $('#btn-scan').addEventListener('click', async () => {
    try {
      await api(`/api/subnets/${encodeURIComponent(detail.id)}/scan`, { method: 'POST' });
      renderSubnetDetail(detail.id);
    } catch (err) {
      alert(`扫描失败：${err.message}`);
    }
  });
  $('#btn-delete').addEventListener('click', async () => {
    if (!confirm('确定要删除该子网及其历史记录吗？此操作不可撤销。')) return;
    try {
      await api(`/api/subnets/${encodeURIComponent(detail.id)}`, { method: 'DELETE' });
      if (readLastSubnetId() === detail.id) saveLastSubnetId(null);
      navigate('#/');
    } catch (err) {
      view.innerHTML = `<div class="card">${notice(err.message)}</div>`;
    }
  });
  $('#filter-status').addEventListener('change', () => renderGrid(detail));
  $('#filter-q').addEventListener('input', () => renderGrid(detail));
}

function renderGrid(detail) {
  const filter = $('#filter-status').value;
  const q = $('#filter-q').value.trim().toLowerCase();
  const records = detail.records;
  const filtered = records.filter((r) => {
    if (filter !== 'all' && r.status !== filter) return false;
    if (q) {
      const hay = `${r.ip} ${r.mac ?? ''} ${r.hostname ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const grid = $('#address-grid');
  grid.innerHTML = '';
  // for very large subnets, virtualise: only render cells in viewport-sized window
  const MAX_DOM = 4000;
  const toRender = filtered.slice(0, MAX_DOM);
  const fragment = document.createDocumentFragment();
  for (const r of toRender) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'address-cell';
    cell.dataset.status = r.status;
    cell.dataset.icon = STATUS_ICON[r.status] ?? '';
    cell.dataset.ip = r.ip;
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', `${r.ip} ${STATUS_LABEL_FULL[r.status] ?? r.status}`);
    cell.tabIndex = 0;
    cell.textContent = r.ip.split('.').slice(-1)[0];
    fragment.appendChild(cell);
  }
  grid.appendChild(fragment);
  const countText = filtered.length > MAX_DOM
    ? `已显示 ${toRender.length} 个（共 ${filtered.length}，请缩小筛选范围查看更多）`
    : `共 ${filtered.length} / ${records.length} 个地址`;
  $('#grid-count').textContent = countText;
  $('#grid-empty').hidden = filtered.length !== 0;
}

// ---- Tooltip (hover + keyboard focus) ----

const tooltipEl = () => $('#tooltip');
function showTooltip(target, rect) {
  const ip = target.dataset.ip;
  const r = state.currentDetail?.records.find((x) => x.ip === ip);
  if (!r) return;
  const tt = tooltipEl();
  const stLabel = STATUS_LABEL_FULL[r.status] ?? r.status;
  const lastOctet = ip.split('.').slice(-1)[0];
  tt.innerHTML = `
    <h4>${escapeHtml(ip)} <span class="badge" data-status="${escapeAttr(r.status)}">${escapeHtml(stLabel)}</span></h4>
    <dl>
      <dt>状态</dt><dd>${escapeHtml(stLabel)}</dd>
      <dt>主机号</dt><dd>${escapeHtml(lastOctet)}</dd>
      <dt>MAC 地址</dt><dd>${escapeHtml(r.mac ?? '未知')}</dd>
      <dt>主机名</dt><dd>${escapeHtml(r.hostname ?? '未知')}</dd>
      <dt>开放端口</dt><dd>${r.openPorts?.length ? escapeHtml(r.openPorts.join(', ')) : (r.status === 'free' ? '无' : '未知')}</dd>
      <dt>响应时间</dt><dd>${r.responseMs != null ? escapeHtml(String(r.responseMs)) + ' ms' : '未知'}</dd>
      <dt>探测来源</dt><dd>${escapeHtml(r.source ?? '未知')}</dd>
      <dt>探测时间</dt><dd>${r.discoveredAt ? escapeHtml(new Date(r.discoveredAt).toLocaleString()) : '—'}</dd>
      ${r.note ? `<dt>备注</dt><dd>${escapeHtml(r.note)}</dd>` : ''}
    </dl>`;
  tt.hidden = false;
  const padding = 12;
  const x = Math.min(window.innerWidth - tt.offsetWidth - padding, rect.right + 8);
  const y = Math.min(window.innerHeight - tt.offsetHeight - padding, rect.bottom + 8);
  tt.style.left = `${Math.max(padding, x)}px`;
  tt.style.top = `${Math.max(padding, y)}px`;
}
function hideTooltip() {
  const tt = tooltipEl();
  if (tt) tt.hidden = true;
}

document.addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.address-cell');
  if (cell) showTooltip(cell, cell.getBoundingClientRect());
});
document.addEventListener('mouseout', (e) => {
  const cell = e.target.closest('.address-cell');
  if (cell) hideTooltip();
});
document.addEventListener('focusin', (e) => {
  const cell = e.target.closest('.address-cell');
  if (cell) showTooltip(cell, cell.getBoundingClientRect());
});
document.addEventListener('focusout', (e) => {
  const cell = e.target.closest('.address-cell');
  if (cell) hideTooltip();
});
document.addEventListener('keydown', (e) => {
  if (!e.target.classList?.contains('address-cell')) return;
  const grid = e.target.parentElement;
  const cells = Array.from(grid.querySelectorAll('.address-cell'));
  const idx = cells.indexOf(e.target);
  let next = -1;
  if (e.key === 'ArrowRight') next = idx + 1;
  else if (e.key === 'ArrowLeft') next = idx - 1;
  else if (e.key === 'ArrowDown') next = idx + Math.floor(grid.clientWidth / 60);
  else if (e.key === 'ArrowUp') next = idx - Math.floor(grid.clientWidth / 60);
  if (next >= 0 && next < cells.length) {
    e.preventDefault();
    cells[next].focus();
  }
});

// ---- Scan polling ----

function startScanPolling(id) {
  if (state.scanPollers.has(id)) return;
  let sawRunning = false; // 本次轮询期间是否观察到过“扫描中”
  let failures = 0; // 连续请求失败次数，超过阈值后停止轮询
  const stop = setInterval(async () => {
    let data;
    try {
      data = await api(`/api/subnets/${encodeURIComponent(id)}/scan`);
      failures = 0;
    } catch (err) {
      // 瞬时错误继续重试；连续失败则安静停止，不触发重渲染。
      failures += 1;
      if (failures >= 5) {
        clearInterval(stop);
        state.scanPollers.delete(id);
      }
      return;
    }
    if (data.isScanning && data.job) {
      sawRunning = true;
      const { done = 0, total = 0 } = data.job.progress ?? {};
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      // 只原地更新进度条与文案，不重建页面，避免闪烁。
      const bar = $('#scan-bar');
      if (bar) {
        bar.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
      }
      const text = $('#scan-progress-text');
      if (text) text.textContent = `扫描进行中：${done}/${total}（${pct}%）`;
      return;
    }
    // 空闲：停止轮询即可。仅当确实观察到“扫描中→结束”的跳变时
    // 才刷新一次结果；绝不能在空闲时反复整页重渲染（会造成闪烁）。
    clearInterval(stop);
    state.scanPollers.delete(id);
    if (sawRunning) renderSubnetDetail(id);
  }, 1000);
  state.scanPollers.set(id, stop);
}

// ---- Boot ----

window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  router();
});
