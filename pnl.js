// P&L engine: transaction classification, period windows, metrics and chart series.
// Pure functions only – shared by the service worker (type list) and the popup.

const PnL = (() => {
  // earning  – Robux you earned (amount is already net, i.e. after Roblox's cut)
  // spending – Robux you spent (purchases, ads)
  // signed   – direction depends on the sign of the amount (trades)
  // funding  – Robux you got for real money / Premium (not profit)
  // cashout  – Robux converted to cash via DevEx (not a loss)
  // Types the API rejects with HTTP 400 are skipped automatically during sync.
  const TYPES = {
    Sale:                     { label: 'Sales',                  category: 'earning', taxed: true },
    AffiliateSale:            { label: 'Affiliate Sales',        category: 'earning' },
    GroupPayout:              { label: 'Group Payouts',          category: 'earning' },
    AdImpressionPayout:       { label: 'Ad Revenue',             category: 'earning' },
    EngagementPayout:         { label: 'Premium Payouts',        category: 'earning' },
    GroupEngagementPayout:    { label: 'Group Premium Payouts',  category: 'earning' },
    PublishingAdvanceRebates: { label: 'Publishing Rebates',     category: 'earning' },
    TradeRobux:               { label: 'Trades',                 category: 'signed' },
    Purchase:                 { label: 'Purchases',              category: 'spending' },
    AdSpend:                  { label: 'Ad Spend',               category: 'spending' },
    CurrencyPurchase:         { label: 'Robux Bought',           category: 'funding' },
    PremiumStipend:           { label: 'Premium Stipend',        category: 'funding' },
    DevEx:                    { label: 'DevEx',                  category: 'cashout' }
  };

  // Transaction types queried for groups. Seen from the group, a GroupPayout is money
  // paid out to members – it leaves the group funds but isn't a business expense.
  const GROUP_TYPES = [
    'Sale', 'AffiliateSale', 'EngagementPayout', 'GroupEngagementPayout', 'AdImpressionPayout',
    'PublishingAdvanceRebates', 'Purchase', 'AdSpend', 'GroupPayout'
  ];
  const GROUP_OVERRIDES = {
    GroupPayout: { label: 'Member Payouts', category: 'cashout' }
  };

  /** Type definition for a stored transaction (group records may classify differently). */
  function defOf(t) {
    return (t.scope === 'group' && GROUP_OVERRIDES[t.type]) || TYPES[t.type];
  }

  const CATEGORY_LABELS = {
    earning: 'Income',
    spending: 'Expense',
    signed: 'Trade',
    funding: 'Funding',
    cashout: 'Cash-out'
  };

  const DEFAULT_SETTINGS = {
    devexRate: 0.0035,     // USD per Robux
    marketplaceFee: 30,    // percent Roblox keeps on sales
    displayCurrency: 'USD',
    usdToEur: 0.92,        // manual rate, used when fxLive is off or no live rate is available
    fxLive: true
  };

  const PERIODS = ['1D', '7D', '1M', '1Y', 'ALL'];

  // ---------------------------------------------------------------- windows

  function addUnit(date, unit, n) {
    const d = new Date(date);
    if (unit === 'hour') d.setHours(d.getHours() + n);
    else if (unit === 'day') d.setDate(d.getDate() + n);
    else if (unit === 'month') d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
    return d;
  }

  function bucketLabel(date, unit) {
    if (unit === 'hour') return `${String(date.getHours()).padStart(2, '0')}:00`;
    if (unit === 'day') return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (unit === 'month') return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    return String(date.getFullYear());
  }

  /**
   * Calendar-aligned window for a period key, split into chart buckets.
   * 1D = last 24 hours, 7D/1M = last 7/30 days, 1Y = last 12 months,
   * ALL = since the first stored transaction (monthly, or yearly beyond 3 years).
   */
  function periodWindow(key, now = Date.now(), firstTs = null) {
    const n = new Date(now);
    const y = n.getFullYear(), m = n.getMonth(), d = n.getDate();
    let unit, count, start;

    switch (key) {
      case '1D': unit = 'hour';  count = 24; start = new Date(y, m, d, n.getHours() - 23); break;
      case '7D': unit = 'day';   count = 7;  start = new Date(y, m, d - 6); break;
      case '1M': unit = 'day';   count = 30; start = new Date(y, m, d - 29); break;
      case '1Y': unit = 'month'; count = 12; start = new Date(y, m - 11, 1); break;
      default: {
        const f = new Date(firstTs ?? now);
        const months = (y - f.getFullYear()) * 12 + (m - f.getMonth()) + 1;
        if (months <= 36) {
          unit = 'month'; count = months; start = new Date(f.getFullYear(), f.getMonth(), 1);
        } else {
          unit = 'year'; count = y - f.getFullYear() + 1; start = new Date(f.getFullYear(), 0, 1);
        }
      }
    }

    const buckets = [];
    for (let i = 0; i < count; i++) {
      const s = addUnit(start, unit, i);
      buckets.push({ start: s.getTime(), end: addUnit(start, unit, i + 1).getTime(), label: bucketLabel(s, unit) });
    }
    return { unit, buckets, from: buckets[0].start, to: buckets[buckets.length - 1].end - 1 };
  }

  /**
   * Finer buckets for the price chart, so it reads like a stock chart:
   * 1D = 1 h candles, 7D = 4 h, 1M = 1 day, 1Y = 1 week,
   * ALL = 1 week (1 month once the history is longer than 3 years).
   * Starts exactly where periodWindow() starts, so the chart's last
   * cumulative P&L equals the period's net P&L.
   */
  function candleWindow(key, now = Date.now(), firstTs = null) {
    const pw = periodWindow(key, now, firstTs);
    const SPECS = { '1D': ['hour', 1, '1h'], '7D': ['hour', 4, '4h'], '1M': ['day', 1, '1D'], '1Y': ['day', 7, '1W'] };
    const [unit, step, interval] = SPECS[key] || (now - pw.from > 3 * 365 * 864e5 ? ['month', 1, '1M'] : ['day', 7, '1W']);

    const buckets = [];
    for (let s = new Date(pw.from); s.getTime() <= pw.to;) {
      const e = addUnit(s, unit, step);
      buckets.push({ start: s.getTime(), end: e.getTime() });
      s = e;
    }
    return { intraday: unit === 'hour', interval, buckets, from: pw.from, to: buckets[buckets.length - 1].end - 1 };
  }

  function bucketIndex(buckets, ts) {
    let lo = 0, hi = buckets.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ts < buckets[mid].start) hi = mid - 1;
      else if (ts >= buckets[mid].end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  // ---------------------------------------------------------------- metrics

  /** Splits one transaction into P&L components (all values positive Robux). */
  function classify(t) {
    const def = defOf(t);
    const out = { earnTaxed: 0, earnOther: 0, spent: 0, funding: 0, cashout: 0 };
    if (!def || t.currency !== 'Robux') return out;
    const abs = Math.abs(t.amount);
    switch (def.category) {
      case 'earning': out[def.taxed ? 'earnTaxed' : 'earnOther'] = abs; break;
      case 'spending': out.spent = abs; break;
      case 'signed': if (t.amount >= 0) out.earnOther = t.amount; else out.spent = -t.amount; break;
      case 'funding': out.funding = abs; break;
      case 'cashout': out.cashout = abs; break;
    }
    return out;
  }

  /** Signed effect of a transaction on the Robux balance (pending ones don't count yet). */
  function balanceDelta(t) {
    if (t.isPending) return 0;
    const c = classify(t);
    return c.earnTaxed + c.earnOther + c.funding - c.spent - c.cashout;
  }

  function summarize(txs, settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const feeShare = Math.min(Math.max(s.marketplaceFee, 0), 99) / 100;
    let salesNet = 0, otherEarn = 0, spent = 0, funding = 0, cashout = 0, pending = 0, count = 0;

    for (const t of txs) {
      const c = classify(t);
      if (!defOf(t) || t.currency !== 'Robux') continue;
      count++;
      salesNet += c.earnTaxed;
      otherEarn += c.earnOther;
      spent += c.spent;
      funding += c.funding;
      cashout += c.cashout;
      if (t.isPending) pending += c.earnTaxed + c.earnOther;
    }

    // Sale amounts arrive net of the marketplace fee; gross them back up.
    const salesGross = salesNet / (1 - feeShare);
    const netProfit = salesNet + otherEarn;
    const netPnl = netProfit - spent;

    return {
      count,
      grossRevenue: salesGross + otherEarn,
      marketplaceFees: salesGross - salesNet,
      netProfit,
      totalSpent: spent,
      netPnl,
      funding,
      cashout,
      pending,
      devexUsd: netPnl * s.devexRate
    };
  }

  /** Per-bucket inflow/outflow, cumulative net P&L and estimated balance. */
  function series(txs, buckets, currentBalance) {
    const n = buckets.length;
    const inflow = new Array(n).fill(0);
    const outflow = new Array(n).fill(0);
    const delta = new Array(n).fill(0);

    for (const t of txs) {
      const i = bucketIndex(buckets, t.created);
      if (i < 0) continue;
      const c = classify(t);
      inflow[i] += c.earnTaxed + c.earnOther;
      outflow[i] += c.spent;
      delta[i] += balanceDelta(t);
    }

    const cumulative = [];
    let run = 0;
    for (let i = 0; i < n; i++) { run += inflow[i] - outflow[i]; cumulative.push(run); }

    // Walk backwards from today's live balance: balance at the end of bucket i
    // equals the current balance minus everything that happened afterwards.
    let balance = null;
    if (Number.isFinite(currentBalance)) {
      balance = new Array(n);
      let b = currentBalance;
      for (let i = n - 1; i >= 0; i--) { balance[i] = b; b -= delta[i]; }
    }

    return { labels: buckets.map((b) => b.label), inflow, outflow, cumulative, balance };
  }

  /**
   * OHLC candles + volume per bucket.
   * mode 'balance': walks the Robux balance, anchored at the live balance (settled transactions only);
   * mode 'pnl':     cumulative net P&L, starting at 0.
   * Volume = Robux moved in the bucket (income + spending).
   */
  function ohlc(txs, buckets, { mode = 'balance', currentBalance = 0 } = {}) {
    const delta = mode === 'pnl'
      ? (t) => { const c = classify(t); return c.earnTaxed + c.earnOther - c.spent; }
      : balanceDelta;
    const inRange = txs.filter((t) => t.created >= buckets[0].start).sort((a, b) => a.created - b.created);
    let run = mode === 'pnl' ? 0 : currentBalance - inRange.reduce((sum, t) => sum + delta(t), 0);

    const candles = [];
    const volume = [];
    let i = 0;
    for (const b of buckets) {
      const open = run;
      let high = run, low = run, flow = 0;
      for (; i < inRange.length && inRange[i].created < b.end; i++) {
        const t = inRange[i];
        run += delta(t);
        if (run > high) high = run;
        if (run < low) low = run;
        const c = classify(t);
        flow += c.earnTaxed + c.earnOther + c.spent;
      }
      candles.push({ time: b.start, open, high, low, close: run });
      volume.push({ time: b.start, value: flow, up: run >= open });
    }
    return { candles, volume };
  }

  function breakdown(txs) {
    const rows = new Map();
    for (const t of txs) {
      const def = defOf(t);
      if (!def || t.currency !== 'Robux') continue;
      const c = classify(t);
      const signed = c.earnTaxed + c.earnOther + c.funding - c.spent - c.cashout;
      const row = rows.get(t.type) || { type: t.type, label: def.label, category: def.category, count: 0, robux: 0 };
      row.count++;
      row.robux += signed;
      rows.set(t.type, row);
    }
    return [...rows.values()].sort((a, b) => Math.abs(b.robux) - Math.abs(a.robux));
  }

  function topItems(txs, limit = 5) {
    const items = new Map();
    for (const t of txs) {
      if (t.type !== 'Sale' || t.currency !== 'Robux') continue;
      const name = t.itemName || t.placeName || 'Unknown';
      const it = items.get(name) || { name, count: 0, robux: 0 };
      it.count++;
      it.robux += Math.abs(t.amount);
      items.set(name, it);
    }
    return [...items.values()].sort((a, b) => b.robux - a.robux).slice(0, limit);
  }

  /** USD amount in the display currency. */
  function toDisplayMoney(usd, settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    return s.displayCurrency === 'EUR' ? usd * s.usdToEur : usd;
  }

  return {
    TYPES, GROUP_TYPES, CATEGORY_LABELS, DEFAULT_SETTINGS, PERIODS, defOf,
    periodWindow, candleWindow, classify, balanceDelta, summarize, series, ohlc, breakdown, topItems, toDisplayMoney
  };
})();

if (typeof module !== 'undefined') module.exports = PnL;
