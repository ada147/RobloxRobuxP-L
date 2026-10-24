/* global Chart, DB, PnL, ShareCard */
// Dashboard UI. Reads transactions straight from IndexedDB (same origin as the
// service worker), and follows sync progress through chrome.storage.
// The popup shows the essentials; ?view=tab is the full, wide dashboard.

const ui = {
  period: '7D',
  sharePeriod: '7D',
  full: false,
  settings: { ...PnL.DEFAULT_SETTINGS },
  fx: null,
  pacing: null,
  account: null,
  syncState: null
};

const PERIOD_NAMES = { '1D': 'Last 24 hours', '7D': 'Last 7 days', '1M': 'Last 30 days', '1Y': 'Last 12 months', ALL: 'All time' };
const COLORS = { green: '#2dd4a7', red: '#ff6b7d', accent: '#8b8bff', muted: '#8a8a94', grid: 'rgba(255,255,255,0.05)' };

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

let flowChart = null;
let balanceChart = null;
let renderTimer = null;
let lastRenderAt = 0;

// ------------------------------------------------------------------ formatting

function robux(n, { sign = false } = {}) {
  const v = Math.round(n);
  const prefix = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  return `${prefix}R$ ${nf.format(Math.abs(v))}`;
}

/** Settings with the live exchange rate applied when enabled. */
function calcSettings() {
  const s = ui.settings;
  return s.fxLive && ui.fx?.usdToEur ? { ...s, usdToEur: ui.fx.usdToEur } : s;
}

function money(usd) {
  const s = calcSettings();
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: s.displayCurrency }).format(PnL.toDisplayMoney(usd, s));
}

function relativeTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `${s}s`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

function setSigned(node, value, text) {
  node.textContent = text;
  node.classList.toggle('pos', value > 0);
  node.classList.toggle('neg', value < 0);
}

/** "▲ 12% vs prev." – for costs (invert) a rise is shown in red. */
function setDelta(node, cur, prev, { invert = false } = {}) {
  node.replaceChildren();
  if (prev == null) return;
  let text, up;
  if (prev === 0 && cur === 0) { text = 'no change'; up = null; }
  else if (prev === 0) { text = 'new'; up = cur > 0; }
  else {
    const pct = ((cur - prev) / Math.abs(prev)) * 100;
    up = pct >= 0;
    text = `${up ? '▲' : '▼'} ${Math.abs(pct) >= 1000 ? '999+' : Math.round(Math.abs(pct))}%`;
  }
  const good = up == null ? null : invert ? !up : up;
  const span = el('span', { className: `delta ${good == null ? '' : good ? 'up' : 'down'}`, textContent: text });
  node.append(span, ' vs previous');
}

// ------------------------------------------------------------------ header & sync

function renderAccount() {
  const a = ui.account;
  $('displayName').textContent = a ? a.displayName : 'Not connected';
  $('username').textContent = a ? `@${a.name}` : 'Log in on roblox.com';
  $('username').title = a ? `User ID ${a.userId}` : '';
  $('balance').textContent = a ? nf.format(a.robux) : '—';
  $('balanceDevex').textContent = a ? `≈ ${money(a.robux * ui.settings.devexRate)} DevEx value` : '—';

  const hasAvatar = Boolean(a?.avatarUrl);
  $('avatar').hidden = !hasAvatar;
  $('avatarFallback').hidden = hasAvatar;
  if (hasAvatar) $('avatar').src = a.avatarUrl;
  if (a) $('avatarFallback').textContent = (a.displayName || '?').charAt(0).toUpperCase();
}

function renderSync() {
  const s = ui.syncState;
  const now = Date.now();
  const running = Boolean(s?.running);
  const paused = s?.phase === 'paused';
  $('syncDot').className = 'dot' + (running ? ' run' : paused ? ' warn' : s?.phase === 'error' ? ' err' : s?.lastSync ? ' ok' : '');

  let text = 'Not synced yet';
  if (running && s.waitUntil > now) {
    const left = countdown(s.waitUntil - now);
    text = s.waitReason === 'quota'
      ? `Pacing for Roblox's limit – next request in ${left}`
      : `${s.waitReason} – retrying in ${left}`;
  } else if (running) text = s.message || 'Syncing…';
  else if (paused && s.resumeAt > now) text = `Roblox rate limit – paused, resuming in ${countdown(s.resumeAt - now)}`;
  else if (paused || s?.phase === 'error') text = s.message || s.error;
  else if (s?.lastSync) text = `Synced ${relativeTime(s.lastSync)} · ${s.message || ''}`;
  else if (s?.message) text = s.message;
  $('syncText').textContent = text;
  $('syncText').parentElement.title = text;

  for (const id of ['btnSync', 'btnDeep', 'btnClear']) $(id).disabled = running;
  $('btnSync').classList.toggle('spinning', running);

  $('syncProgress').parentElement.classList.toggle('on', running);
  const frac = running && s.typeCount ? Math.max(s.typeProgress ?? 0, (s.typeIndex || 0) / s.typeCount) : 0;
  $('syncProgress').style.width = `${Math.round(Math.max(frac, 0.03) * 100)}%`;
}

// ------------------------------------------------------------------ dashboard

/** Metrics + chart series for a period; also the previous period of equal length. */
async function loadPeriod(userId, period) {
  const firstTs = await DB.getFirstTimestamp(userId);
  const win = PnL.periodWindow(period, Date.now(), firstTs);
  const txs = await DB.getRange(userId, win.from, win.to);
  const m = PnL.summarize(txs, calcSettings());
  let prev = null;
  if (period !== 'ALL') {
    const len = win.to - win.from + 1;
    prev = PnL.summarize(await DB.getRange(userId, win.from - len, win.from - 1), calcSettings());
  }
  return { win, txs, m, prev, series: PnL.series(txs, win.buckets, ui.account.robux) };
}

async function renderDashboard() {
  lastRenderAt = Date.now();
  const a = ui.account;
  $('dashboard').hidden = !a;
  $('emptyState').hidden = Boolean(a);
  if (!a) {
    $('emptyTitle').textContent = ui.syncState?.errorCode === 'UNAUTHORIZED' ? 'Not logged in' : 'No data yet';
    return;
  }

  for (const b of document.querySelectorAll('#periods button')) b.classList.toggle('active', b.dataset.period === ui.period);
  for (const n of document.querySelectorAll('.periodName')) n.textContent = PERIOD_NAMES[ui.period];

  const { txs, m, prev, series } = await loadPeriod(a.userId, ui.period);

  $('txCount').textContent = `${nf.format(txs.length)} transactions`;

  // Net P&L hero
  setSigned($('kPnl'), m.netPnl, robux(m.netPnl, { sign: true }));
  $('pnlCard').classList.toggle('negative', m.netPnl < 0);
  $('kDevex').textContent = `≈ ${money(m.devexUsd)} DevEx value`;
  setDelta($('kPnlDelta'), m.netPnl, prev?.netPnl);
  $('kEarned').textContent = robux(m.netProfit);
  $('kSpentHero').textContent = robux(m.totalSpent);
  const flow = m.netProfit + m.totalSpent;
  $('splitEarned').style.width = flow ? `${(m.netProfit / flow) * 100}%` : '0';
  $('splitSpent').style.width = flow ? `${(m.totalSpent / flow) * 100}%` : '0';

  // Tiles
  $('kGross').textContent = robux(m.grossRevenue);
  setDelta($('kGrossDelta'), m.grossRevenue, prev?.grossRevenue);
  $('kNet').textContent = robux(m.netProfit);
  setDelta($('kNetDelta'), m.netProfit, prev?.netProfit);
  if (m.pending) $('kNetDelta').append(` · ${robux(m.pending)} pending`);
  $('kSpent').textContent = robux(m.totalSpent);
  setDelta($('kSpentDelta'), m.totalSpent, prev?.totalSpent, { invert: true });
  $('kFees').textContent = robux(m.marketplaceFees);
  $('kFeesSub').textContent = `${ui.settings.marketplaceFee}% of sales`;
  for (const id of ['kGrossDelta', 'kNetDelta', 'kSpentDelta']) {
    if (!$(id).textContent) $(id).textContent = ui.period === 'ALL' ? 'since your first transaction' : '';
  }

  renderFlowChart(series);
  renderBalanceChart(series);
  if (ui.full) {
    renderBreakdown(txs);
    renderTopItems(txs);
    renderRecent(txs);
  }

  $('dbInfo').textContent = `${nf.format(await DB.count(a.userId))} transactions stored locally.`;
}

function scheduleRender(delay = 0) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderDashboard().catch(console.error), delay);
}

// ------------------------------------------------------------------ charts

/** Dashed vertical guide at the hovered point (like a finance app crosshair). */
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const { top, bottom } = chart.chartArea;
    const x = active[0].element.x;
    const ctx = chart.ctx;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  }
};

function tooltipStyle() {
  return {
    backgroundColor: '#26262b',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 10,
    titleColor: '#f4f4f6',
    bodyColor: '#c8c8d0',
    boxPadding: 4,
    usePointStyle: true,
    callbacks: { label: (c) => ` ${c.dataset.label}: ${robux(c.raw)}` }
  };
}

function verticalGradient(rgb, alpha) {
  return (ctx) => {
    const { chart } = ctx;
    if (!chart.chartArea) return 'transparent';
    const { top, bottom } = chart.chartArea;
    const g = chart.ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    return g;
  };
}

function renderFlowChart(s) {
  const data = {
    labels: s.labels,
    datasets: [
      {
        type: 'line', label: 'Cumulative P&L', data: s.cumulative, borderColor: COLORS.accent, borderWidth: 2.5,
        pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 3, pointHoverBorderColor: '#fff',
        pointHoverBackgroundColor: COLORS.accent, tension: 0.4, stack: 'line', order: 1,
        fill: 'origin', backgroundColor: verticalGradient('108, 108, 255', 0.35)
      },
      { type: 'bar', label: 'Income', data: s.inflow, backgroundColor: 'rgba(45, 212, 167, 0.85)', borderRadius: 6, maxBarThickness: 22, stack: 'flow', order: 2 },
      { type: 'bar', label: 'Spending', data: s.outflow.map((v) => -v), backgroundColor: 'rgba(255, 107, 125, 0.85)', borderRadius: 6, maxBarThickness: 22, stack: 'flow', order: 2 }
    ]
  };
  if (flowChart) {
    flowChart.data = data;
    flowChart.update();
    return;
  }
  flowChart = new Chart($('flowChart'), {
    data,
    plugins: [crosshair],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipStyle() },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: ui.full ? 14 : 8 } },
        y: { stacked: true, grid: { color: COLORS.grid }, border: { display: false, dash: [4, 4] }, ticks: { maxTicksLimit: 5, callback: (v) => nf.format(v) } }
      }
    }
  });
}

function renderBalanceChart(s) {
  const data = {
    labels: s.labels,
    datasets: [{
      label: 'Balance', data: s.balance || [], borderColor: COLORS.accent, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: 'start',
      backgroundColor: verticalGradient('108, 108, 255', 0.3)
    }]
  };
  if (balanceChart) {
    balanceChart.data = data;
    balanceChart.update();
    return;
  }
  balanceChart = new Chart($('balanceChart'), {
    type: 'line',
    data,
    plugins: [crosshair],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipStyle() },
      scales: { x: { display: false }, y: { display: false, grace: '10%' } }
    }
  });
}

// ------------------------------------------------------------------ side lists (full view)

function emptyRow(list, text) {
  list.append(el('li', { className: 'empty-row', textContent: text }));
}

function renderBreakdown(txs) {
  const rows = PnL.breakdown(txs);
  const body = $('breakdown').tBodies[0];
  body.replaceChildren();
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { className: 'muted', textContent: 'No transactions in this period' })));
    return;
  }
  const max = Math.max(...rows.map((r) => Math.abs(r.robux)), 1);
  for (const r of rows) {
    const amount = el('td', { className: 'num', textContent: robux(r.robux, { sign: true }) });
    amount.classList.toggle('pos', r.robux > 0);
    amount.classList.toggle('neg', r.robux < 0);
    const fill = el('span');
    fill.style.width = `${(Math.abs(r.robux) / max) * 100}%`;
    fill.style.background = r.robux >= 0 ? COLORS.green : COLORS.red;
    body.append(el('tr', {}, [
      el('td', {}, [
        el('span', { className: 'type-name', textContent: r.label }),
        el('span', { className: 'type-cat', textContent: `${PnL.CATEGORY_LABELS[r.category]} · ${nf.format(r.count)}×` })
      ]),
      el('td', { className: 'bar-cell' }, el('div', { className: 'mini-bar' }, fill)),
      amount
    ]));
  }
}

function renderTopItems(txs) {
  const items = PnL.topItems(txs, 6);
  const list = $('topItems');
  list.replaceChildren();
  if (!items.length) return emptyRow(list, 'No sales in this period');
  for (const it of items) {
    list.append(el('li', {}, [
      el('div', { className: 'name' }, [
        el('b', { textContent: it.name, title: it.name }),
        el('span', { textContent: `${nf.format(it.count)} ${it.count === 1 ? 'sale' : 'sales'}` })
      ]),
      el('div', { className: 'amount pos', textContent: robux(it.robux) })
    ]));
  }
}

function renderRecent(txs) {
  const list = $('recent');
  list.replaceChildren();
  const recent = txs.slice(-7).reverse();
  if (!recent.length) return emptyRow(list, 'No transactions in this period');
  for (const t of recent) {
    const delta = PnL.balanceDelta({ ...t, isPending: false });
    const def = PnL.TYPES[t.type];
    const label = def?.label || t.type;
    const title = t.itemName || t.agentName || label;
    const when = new Date(t.created).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const amount = el('div', { className: 'amount', textContent: robux(delta, { sign: true }) });
    amount.classList.toggle('pos', delta > 0);
    amount.classList.toggle('neg', delta < 0);
    const meta = el('span', { textContent: `${label} · ${when}` });
    if (t.isPending) meta.append(el('em', { className: 'pending', textContent: 'pending' }));
    list.append(el('li', {}, [
      el('div', { className: `initial ${def?.category || ''}`, textContent: title.charAt(0).toUpperCase() }),
      el('div', { className: 'name' }, [el('b', { textContent: title, title }), meta]),
      amount
    ]));
  }
}

// ------------------------------------------------------------------ share card

let avatarBitmap; // undefined = not loaded yet, null = unavailable
let logoImage;

async function loadShareAssets() {
  if (avatarBitmap === undefined) {
    try {
      const res = await fetch(ui.account.avatarUrl);
      avatarBitmap = await createImageBitmap(await res.blob());
    } catch {
      avatarBitmap = null;
    }
  }
  if (!logoImage) {
    logoImage = new Image();
    logoImage.src = 'icons/icon128.png';
    await logoImage.decode().catch(() => {});
  }
  await document.fonts.ready;
}

async function drawShare() {
  const a = ui.account;
  for (const b of document.querySelectorAll('#sharePeriods button')) b.classList.toggle('active', b.dataset.period === ui.sharePeriod);
  const [{ win, m, series }] = await Promise.all([loadPeriod(a.userId, ui.sharePeriod), loadShareAssets()]);
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  ShareCard.render($('shareCanvas'), {
    displayName: a.displayName,
    username: a.name,
    avatar: avatarBitmap,
    logo: logoImage,
    periodName: PERIOD_NAMES[ui.sharePeriod],
    rangeText: `${fmtDate(win.from)} – ${fmtDate(Math.min(win.to, Date.now()))}`,
    metrics: m,
    cumulative: series.cumulative,
    balance: a.robux,
    showBalance: $('shareBalance').checked,
    robux,
    money
  });
}

function shareBlob() {
  return new Promise((resolve, reject) => $('shareCanvas').toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create image'))), 'image/png'));
}

async function openShare() {
  if (!ui.account) return;
  ui.sharePeriod = ui.period;
  $('shareHint').textContent = '';
  $('shareModal').hidden = false;
  $('backdrop').hidden = false;
  await drawShare();
}

function closeOverlays() {
  $('shareModal').hidden = true;
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('backdrop').hidden = true;
}

// ------------------------------------------------------------------ settings & actions

function openDrawer() {
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('backdrop').hidden = false;
}

function renderSettingsInfo() {
  const live = ui.settings.fxLive && ui.fx?.usdToEur;
  $('sEur').disabled = Boolean(live);
  $('sEur').value = live ? ui.fx.usdToEur : ui.settings.usdToEur;
  $('fxInfo').textContent = live ? `· live, ${ui.fx.date}` : ui.settings.fxLive ? '· live rate not loaded yet' : '· manual';

  const budget = ui.pacing?.['economy.roblox.com']?.budget;
  $('paceInfo').textContent = budget
    ? `Learned Roblox limit: ~${budget} requests per minute – syncs stay below it.`
    : 'No Roblox rate limit hit yet – syncing at full speed.';
}

function fillSettingsForm() {
  $('sDevex').value = ui.settings.devexRate;
  $('sFee').value = ui.settings.marketplaceFee;
  $('sCurrency').value = ui.settings.displayCurrency;
  $('sFxLive').checked = ui.settings.fxLive;
  renderSettingsInfo();
}

async function saveSettings() {
  const num = (id, fallback) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const fxLive = $('sFxLive').checked;
  ui.settings = {
    devexRate: num('sDevex', PnL.DEFAULT_SETTINGS.devexRate),
    marketplaceFee: Math.min(num('sFee', PnL.DEFAULT_SETTINGS.marketplaceFee), 99),
    displayCurrency: $('sCurrency').value,
    // keep the manual rate untouched while the field shows the live one
    usdToEur: fxLive && ui.fx?.usdToEur ? ui.settings.usdToEur : num('sEur', PnL.DEFAULT_SETTINGS.usdToEur),
    fxLive
  };
  await chrome.storage.local.set({ settings: ui.settings });
  renderSettingsInfo();
  renderAccount();
  scheduleRender();
}

async function exportCsv() {
  if (!ui.account) return;
  const rows = await DB.getAll(ui.account.userId);
  const cols = ['created', 'type', 'apiType', 'amount', 'currency', 'isPending', 'itemName', 'itemType', 'itemId', 'agentName', 'agentType', 'agentId', 'placeName', 'key'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => esc(c === 'created' ? new Date(r.created).toISOString() : r[c])).join(','));
  }
  download(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }),
    `robux-transactions-${ui.account.name}-${new Date().toISOString().slice(0, 10)}.csv`);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function clearData() {
  if (!ui.account) return;
  if (!confirm('Delete all locally stored transactions for this account? The next sync will read the history again.')) return;
  const res = await chrome.runtime.sendMessage({ type: 'RESET_DATA', userId: ui.account.userId });
  if (!res?.ok) alert(res?.error || 'Delete failed');
  scheduleRender();
}

function openFullDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab') });
}

function bindEvents() {
  $('periods').addEventListener('click', async (e) => {
    const p = e.target.closest('button')?.dataset.period;
    if (!p) return;
    ui.period = p;
    await chrome.storage.local.set({ period: p });
    scheduleRender();
  });

  $('btnSync').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'SYNC', mode: 'incremental' }));
  $('btnDeep').addEventListener('click', () => {
    if (confirm('Re-read the entire transaction history? On large accounts this can take several minutes.')) {
      chrome.runtime.sendMessage({ type: 'SYNC', mode: 'deep' });
      closeOverlays();
    }
  });
  $('btnTab').addEventListener('click', openFullDashboard);
  $('btnMore').addEventListener('click', openFullDashboard);
  $('btnSettings').addEventListener('click', openDrawer);
  $('btnCloseSettings').addEventListener('click', closeOverlays);
  $('backdrop').addEventListener('click', closeOverlays);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlays(); });
  $('btnExport').addEventListener('click', () => exportCsv().catch((e) => alert(e.message)));
  $('btnClear').addEventListener('click', () => clearData().catch((e) => alert(e.message)));
  for (const id of ['sDevex', 'sFee', 'sCurrency', 'sEur', 'sFxLive']) $(id).addEventListener('change', saveSettings);

  // share dialog
  $('btnShare').addEventListener('click', () => openShare().catch(console.error));
  $('btnCloseShare').addEventListener('click', closeOverlays);
  $('sharePeriods').addEventListener('click', (e) => {
    const p = e.target.closest('button')?.dataset.period;
    if (!p) return;
    ui.sharePeriod = p;
    drawShare().catch(console.error);
  });
  $('shareBalance').addEventListener('change', () => drawShare().catch(console.error));
  $('btnDownloadPng').addEventListener('click', async () => {
    download(await shareBlob(), `robux-pnl-${ui.account.name}-${ui.sharePeriod.toLowerCase()}.png`);
  });
  $('btnCopyPng').addEventListener('click', async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': shareBlob() })]);
      $('shareHint').textContent = 'Copied – paste it anywhere.';
    } catch (err) {
      $('shareHint').textContent = `Copy failed: ${err.message}`;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.account) {
      ui.account = changes.account.newValue || null;
      avatarBitmap = undefined;
      renderAccount();
      scheduleRender();
    }
    if (changes.fx) {
      ui.fx = changes.fx.newValue || null;
      renderSettingsInfo();
      renderAccount();
      scheduleRender();
    }
    if (changes.apiPacing) {
      ui.pacing = changes.apiPacing.newValue || null;
      renderSettingsInfo();
    }
    if (changes.syncState) {
      const prev = changes.syncState.oldValue;
      ui.syncState = changes.syncState.newValue || null;
      renderSync();
      const s = ui.syncState;
      if (!s?.running && prev?.running) scheduleRender();
      // While a scan is filling the database, refresh at most every 2.5 s.
      else if (s?.running && s.added !== prev?.added) scheduleRender(Math.max(0, 2500 - (Date.now() - lastRenderAt)));
      else if (s?.phase === 'reset') scheduleRender();
    }
  });
}

async function init() {
  ui.full = new URLSearchParams(location.search).get('view') === 'tab';
  document.body.classList.toggle('full', ui.full);

  Chart.defaults.color = COLORS.muted;
  Chart.defaults.borderColor = COLORS.grid;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;

  const stored = await chrome.storage.local.get(['settings', 'account', 'syncState', 'period', 'fx', 'apiPacing']);
  ui.settings = { ...PnL.DEFAULT_SETTINGS, ...stored.settings };
  ui.account = stored.account || null;
  ui.syncState = stored.syncState || null;
  ui.fx = stored.fx || null;
  ui.pacing = stored.apiPacing || null;
  if (PnL.PERIODS.includes(stored.period)) ui.period = stored.period;

  fillSettingsForm();
  bindEvents();
  renderAccount();
  renderSync();
  await renderDashboard();

  // Opening the dashboard pulls fresh data (the worker skips it if the last sync was recent).
  chrome.runtime.sendMessage({ type: 'SYNC', mode: 'auto' });
  setInterval(renderSync, 1000); // live countdowns
}

init().catch((err) => {
  console.error(err);
  $('syncText').textContent = `Error: ${err.message}`;
});
