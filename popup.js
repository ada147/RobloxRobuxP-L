/* global Chart, DB, PnL */
// Dashboard UI. Reads transactions straight from IndexedDB (same origin as the
// service worker), and follows sync progress through chrome.storage.

const ui = {
  period: '7D',
  tab: 'breakdown',
  settings: { ...PnL.DEFAULT_SETTINGS },
  account: null,
  syncState: null
};

const PERIOD_NAMES = { '1D': 'Last 24 hours', '7D': 'Last 7 days', '1M': 'Last 30 days', '1Y': 'Last 12 months', ALL: 'All time' };
const COLORS = { green: '#1fbf75', red: '#f0596a', blue: '#5b8cff', amber: '#f5b544', muted: '#8b94a4', grid: 'rgba(255,255,255,0.05)' };

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

function money(usd) {
  const value = PnL.toDisplayMoney(usd, ui.settings);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: ui.settings.displayCurrency }).format(value);
}

function relativeTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
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
  const running = Boolean(s?.running);
  const paused = s?.phase === 'paused';
  $('syncDot').className = 'dot' + (running ? ' run' : paused ? ' warn' : s?.phase === 'error' ? ' err' : s?.lastSync ? ' ok' : '');

  let text = 'Not synced yet';
  if (running) text = s.message || 'Syncing…';
  else if (paused || s?.phase === 'error') text = s.message || s.error;
  else if (s?.lastSync) text = `Synced ${relativeTime(s.lastSync)} · ${s.message || ''}`;
  else if (s?.message) text = s.message;
  $('syncText').textContent = text;
  $('syncText').title = text;

  for (const id of ['btnSync', 'btnDeep', 'btnClear']) $(id).disabled = running;
  $('btnSync').classList.toggle('spinning', running);

  $('syncProgress').parentElement.classList.toggle('on', running);
  const frac = running && s.typeCount ? Math.max(s.typeProgress ?? 0, (s.typeIndex || 0) / s.typeCount) : 0;
  $('syncProgress').style.width = `${Math.round(Math.max(frac, 0.03) * 100)}%`;
}

// ------------------------------------------------------------------ dashboard

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

  const firstTs = await DB.getFirstTimestamp(a.userId);
  const win = PnL.periodWindow(ui.period, Date.now(), firstTs);
  const txs = await DB.getRange(a.userId, win.from, win.to);
  const m = PnL.summarize(txs, ui.settings);

  $('txCount').textContent = `${nf.format(txs.length)} transactions`;

  // Net P&L hero
  setSigned($('kPnl'), m.netPnl, robux(m.netPnl, { sign: true }));
  $('kDevex').textContent = `≈ ${money(m.devexUsd)} DevEx value`;
  $('kEarned').textContent = robux(m.netProfit);
  $('kSpentHero').textContent = robux(m.totalSpent);
  const flow = m.netProfit + m.totalSpent;
  $('splitEarned').style.width = flow ? `${(m.netProfit / flow) * 100}%` : '0';
  $('splitSpent').style.width = flow ? `${(m.totalSpent / flow) * 100}%` : '0';
  $('kPnlFoot').textContent = [
    m.funding ? `${robux(m.funding)} bought` : '',
    m.cashout ? `${robux(m.cashout)} cashed out via DevEx` : ''
  ].filter(Boolean).join(' · ') || 'Net profit − total spent';

  // Stat tiles
  $('kGross').textContent = robux(m.grossRevenue);
  $('kNet').textContent = robux(m.netProfit);
  $('kNetSub').textContent = m.pending ? `${robux(m.pending)} still pending` : 'after marketplace fee';
  $('kSpent').textContent = robux(m.totalSpent);
  $('kFees').textContent = robux(m.marketplaceFees);
  $('kFeesSub').textContent = `${ui.settings.marketplaceFee}% of sales`;

  const series = PnL.series(txs, win.buckets, a.robux);
  renderFlowChart(series);
  renderBalanceChart(series);
  renderBreakdown(txs);
  renderTopItems(txs);
  renderRecent(txs);

  $('dbInfo').textContent = `${nf.format(await DB.count(a.userId))} transactions stored locally.`;
}

function scheduleRender(delay = 0) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderDashboard().catch(console.error), delay);
}

function tooltipStyle() {
  return {
    backgroundColor: '#1c212a',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    titleColor: '#eef1f5',
    bodyColor: '#c9d0db',
    boxPadding: 4,
    callbacks: { label: (c) => ` ${c.dataset.label}: ${robux(c.raw)}` }
  };
}

function verticalGradient(color, alpha) {
  return (ctx) => {
    const { chart } = ctx;
    if (!chart.chartArea) return 'transparent';
    const { top, bottom } = chart.chartArea;
    const g = chart.ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, color.replace(')', `, ${alpha})`).replace('rgb', 'rgba'));
    g.addColorStop(1, color.replace(')', ', 0)').replace('rgb', 'rgba'));
    return g;
  };
}

function renderFlowChart(s) {
  const data = {
    labels: s.labels,
    datasets: [
      {
        type: 'line', label: 'Cumulative P&L', data: s.cumulative, borderColor: COLORS.blue, borderWidth: 2.5,
        pointRadius: 0, pointHoverRadius: 4, tension: 0.35, stack: 'line', order: 1,
        fill: 'origin', backgroundColor: verticalGradient('rgb(91, 140, 255)', 0.22)
      },
      { type: 'bar', label: 'Income', data: s.inflow, backgroundColor: COLORS.green, borderRadius: 5, maxBarThickness: 26, stack: 'flow', order: 2 },
      { type: 'bar', label: 'Spending', data: s.outflow.map((v) => -v), backgroundColor: COLORS.red, borderRadius: 5, maxBarThickness: 26, stack: 'flow', order: 2 }
    ]
  };
  if (flowChart) {
    flowChart.data = data;
    flowChart.update();
    return;
  }
  flowChart = new Chart($('flowChart'), {
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipStyle() },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
        y: { stacked: true, grid: { color: COLORS.grid }, border: { display: false }, ticks: { maxTicksLimit: 5, callback: (v) => nf.format(v) } }
      }
    }
  });
}

function renderBalanceChart(s) {
  const data = {
    labels: s.labels,
    datasets: [{
      label: 'Balance', data: s.balance || [], borderColor: COLORS.green, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 3, tension: 0.35, fill: 'start',
      backgroundColor: verticalGradient('rgb(31, 191, 117)', 0.25)
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
      el('td', {}, [r.label, el('span', { className: `badge ${r.category}`, textContent: PnL.CATEGORY_LABELS[r.category] })]),
      el('td', { className: 'bar-cell' }, el('div', { className: 'mini-bar' }, fill)),
      el('td', { className: 'num muted', textContent: `${nf.format(r.count)}×` }),
      amount
    ]));
  }
}

function renderTopItems(txs) {
  const items = PnL.topItems(txs, 8);
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
  const recent = txs.slice(-8).reverse();
  if (!recent.length) return emptyRow(list, 'No transactions in this period');
  for (const t of recent) {
    const delta = PnL.balanceDelta({ ...t, isPending: false });
    const label = PnL.TYPES[t.type]?.label || t.type;
    const title = t.itemName || t.agentName || label;
    const when = new Date(t.created).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const amount = el('div', { className: 'amount', textContent: robux(delta, { sign: true }) });
    amount.classList.toggle('pos', delta > 0);
    amount.classList.toggle('neg', delta < 0);
    const meta = el('span', { textContent: `${label} · ${when}` });
    if (t.isPending) meta.append(el('em', { className: 'pending', textContent: 'pending' }));
    list.append(el('li', {}, [
      el('div', { className: 'name' }, [el('b', { textContent: title, title }), meta]),
      amount
    ]));
  }
}

function renderTabs() {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === ui.tab);
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== ui.tab;
}

// ------------------------------------------------------------------ settings & actions

function openDrawer(open) {
  $('drawer').classList.toggle('open', open);
  $('drawer').setAttribute('aria-hidden', String(!open));
  $('backdrop').hidden = !open;
}

function fillSettingsForm() {
  $('sDevex').value = ui.settings.devexRate;
  $('sFee').value = ui.settings.marketplaceFee;
  $('sCurrency').value = ui.settings.displayCurrency;
  $('sEur').value = ui.settings.usdToEur;
}

async function saveSettings() {
  const num = (id, fallback) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  ui.settings = {
    devexRate: num('sDevex', PnL.DEFAULT_SETTINGS.devexRate),
    marketplaceFee: Math.min(num('sFee', PnL.DEFAULT_SETTINGS.marketplaceFee), 99),
    displayCurrency: $('sCurrency').value,
    usdToEur: num('sEur', PnL.DEFAULT_SETTINGS.usdToEur)
  };
  await chrome.storage.local.set({ settings: ui.settings });
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
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: `robux-transactions-${ui.account.name}-${new Date().toISOString().slice(0, 10)}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function clearData() {
  if (!ui.account) return;
  if (!confirm('Delete all locally stored transactions for this account? The next sync will read the history again.')) return;
  const res = await chrome.runtime.sendMessage({ type: 'RESET_DATA', userId: ui.account.userId });
  if (!res?.ok) alert(res?.error || 'Delete failed');
  scheduleRender();
}

function bindEvents() {
  $('periods').addEventListener('click', async (e) => {
    const p = e.target.closest('button')?.dataset.period;
    if (!p) return;
    ui.period = p;
    await chrome.storage.local.set({ period: p });
    scheduleRender();
  });

  $('tabs').addEventListener('click', (e) => {
    const t = e.target.closest('button')?.dataset.tab;
    if (!t) return;
    ui.tab = t;
    renderTabs();
    chrome.storage.local.set({ tab: t });
  });

  $('btnSync').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'SYNC', mode: 'incremental' }));
  $('btnDeep').addEventListener('click', () => {
    if (confirm('Re-read the entire transaction history? On large accounts this can take several minutes.')) {
      chrome.runtime.sendMessage({ type: 'SYNC', mode: 'deep' });
      openDrawer(false);
    }
  });
  $('btnTab').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab') }));
  $('btnSettings').addEventListener('click', () => openDrawer(true));
  $('btnCloseSettings').addEventListener('click', () => openDrawer(false));
  $('backdrop').addEventListener('click', () => openDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openDrawer(false); });
  $('btnExport').addEventListener('click', () => exportCsv().catch((e) => alert(e.message)));
  $('btnClear').addEventListener('click', () => clearData().catch((e) => alert(e.message)));
  for (const id of ['sDevex', 'sFee', 'sCurrency', 'sEur']) $(id).addEventListener('change', saveSettings);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.account) {
      ui.account = changes.account.newValue || null;
      renderAccount();
      scheduleRender();
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
  if (new URLSearchParams(location.search).get('view') === 'tab') document.body.classList.add('full');

  Chart.defaults.color = COLORS.muted;
  Chart.defaults.borderColor = COLORS.grid;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;

  const stored = await chrome.storage.local.get(['settings', 'account', 'syncState', 'period', 'tab']);
  ui.settings = { ...PnL.DEFAULT_SETTINGS, ...stored.settings };
  ui.account = stored.account || null;
  ui.syncState = stored.syncState || null;
  if (PnL.PERIODS.includes(stored.period)) ui.period = stored.period;
  if (['breakdown', 'top', 'recent'].includes(stored.tab)) ui.tab = stored.tab;

  fillSettingsForm();
  bindEvents();
  renderAccount();
  renderSync();
  renderTabs();
  await renderDashboard();

  // Opening the dashboard pulls fresh data (the worker skips it if the last sync was moments ago).
  chrome.runtime.sendMessage({ type: 'SYNC', mode: 'auto' });
  setInterval(renderSync, 30000);
}

init().catch((err) => {
  console.error(err);
  $('syncText').textContent = `Error: ${err.message}`;
});
