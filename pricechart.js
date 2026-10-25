/* global LightweightCharts */
// Trading-style price chart (TradingView Lightweight Charts) with a volume pane
// and an OHLC legend. Candles come from PnL.ohlc(): { candles, volume }.

const PriceChart = (() => {
  const UP = '#2dd4a7';
  const DOWN = '#ff6b7d';
  const ACCENT = '#8b8bff';

  // Lightweight Charts renders timestamps as UTC – shift them so axis labels show local time.
  const toChartTime = (ms) => Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / 1000);

  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  };

  /**
   * formatPrice: axis labels (plain number); formatValue: tooltip value (e.g. "R$ 1,234");
   * onHover(index | null): crosshair moved onto a bar / left the chart.
   */
  function create(container, { compact = false, formatPrice, formatValue = formatPrice, onHover } = {}) {
    const chart = LightweightCharts.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#8a8a94',
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.035)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.035)' }
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(255, 255, 255, 0.28)', style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#2a2a2f' },
        horzLine: { color: 'rgba(255, 255, 255, 0.28)', style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#2a2a2f' }
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.24 } },
      timeScale: { borderVisible: false, rightOffset: compact ? 1 : 4, fixLeftEdge: true },
      localization: { priceFormatter: formatPrice },
      // The wheel keeps scrolling the page; pan by dragging, zoom by dragging an axis or pinching.
      handleScroll: !compact && { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: !compact && { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true }
    });

    const volume = chart.addHistogramSeries({
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });

    let main = null;
    let type = null;
    let data = null;
    let intradayData = false;
    let times = new Map(); // chart time -> bar index

    // Floating value box that follows the mouse.
    const tip = el('div', 'chart-tip');
    tip.hidden = true;
    container.append(tip);

    function showTip(i, point) {
      const c = data.candles[i];
      const change = c.close - c.open;
      const dir = change > 0 ? 'up' : change < 0 ? 'down' : '';
      const pct = c.open ? ` (${change >= 0 ? '+' : '−'}${Math.abs((change / c.open) * 100).toFixed(2)}%)` : '';
      const when = new Date(c.time).toLocaleString('en-US', intradayData
        ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
        : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

      tip.replaceChildren(
        el('div', 'tip-date', when),
        el('div', `tip-value ${dir}`, formatValue(c.close)),
        el('div', `tip-change ${dir}`, `${change > 0 ? '▲' : change < 0 ? '▼' : '•'} ${formatPrice(Math.abs(change))}${pct}`)
      );
      const grid = el('div', 'tip-grid');
      const rows = type === 'candles'
        ? [['Open', c.open], ['High', c.high], ['Low', c.low], ['Close', c.close]]
        : [['Start', c.open], ['End', c.close]];
      for (const [k, v] of rows) grid.append(el('span', null, k), el('b', null, formatPrice(v)));
      grid.append(el('span', null, 'Volume'), el('b', null, formatPrice(data.volume[i].value)));
      tip.append(grid);

      // Place next to the cursor, flipping sides near the edges.
      tip.hidden = false;
      const gap = 16;
      const { width: w, height: h } = tip.getBoundingClientRect();
      const W = container.clientWidth, H = container.clientHeight;
      let x = point.x + gap, y = point.y + gap;
      if (x + w > W - 60) x = point.x - w - gap;   // keep clear of the price axis
      if (y + h > H - 30) y = point.y - h - gap;   // and of the time axis
      tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
    }

    function buildSeries(t) {
      if (main) chart.removeSeries(main);
      type = t;
      const common = { priceLineStyle: LightweightCharts.LineStyle.Dotted, priceLineColor: 'rgba(255, 255, 255, 0.35)' };
      if (t === 'candles') {
        main = chart.addCandlestickSeries({
          ...common, upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false
        });
      } else if (t === 'line') {
        main = chart.addLineSeries({ ...common, color: ACCENT, lineWidth: 2, crosshairMarkerRadius: 4 });
      } else {
        main = chart.addAreaSeries({
          ...common, lineColor: ACCENT, lineWidth: 2,
          topColor: 'rgba(108, 108, 255, 0.38)', bottomColor: 'rgba(108, 108, 255, 0)', crosshairMarkerRadius: 4
        });
      }
    }

    function render() {
      // Strictly increasing times (DST can map two local hours onto one).
      let prev = -Infinity;
      const t = data.candles.map((c) => {
        const ct = Math.max(toChartTime(c.time), prev + 1);
        prev = ct;
        return ct;
      });
      times = new Map(t.map((ct, i) => [ct, i]));
      main.setData(type === 'candles'
        ? data.candles.map((c, i) => ({ time: t[i], open: c.open, high: c.high, low: c.low, close: c.close }))
        : data.candles.map((c, i) => ({ time: t[i], value: c.close })));
      volume.setData(data.volume.map((v, i) => ({
        time: t[i], value: v.value, color: v.up ? 'rgba(45, 212, 167, 0.32)' : 'rgba(255, 107, 125, 0.32)'
      })));
      chart.timeScale().fitContent();
    }

    // The container may have no width yet when data arrives (or the window is resized):
    // re-fit once it has a real size so the candles span the full pane.
    let lastWidth = 0;
    new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (data && w > 0 && Math.abs(w - lastWidth) > 20) chart.timeScale().fitContent();
      lastWidth = w;
    }).observe(container);

    chart.subscribeCrosshairMove((param) => {
      if (!data) return;
      const i = param.time != null ? times.get(param.time) : undefined;
      const inside = param.point && param.point.x >= 0 && param.point.y >= 0;
      if (i != null && inside && !compact) showTip(i, param.point);
      else tip.hidden = true;
      onHover?.(i ?? null);
    });
    container.addEventListener('mouseleave', () => { tip.hidden = true; });

    return {
      /** opts: { type: 'candles' | 'line' | 'area', intraday: boolean } */
      setData(d, { type: t = 'candles', intraday = false } = {}) {
        data = d;
        intradayData = intraday;
        chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
        if (t !== type) buildSeries(t);
        render();
      },
      setType(t) {
        if (t === type || !data) return;
        buildSeries(t);
        render();
      },
      /** Back to the default view: all candles visible, price scale auto-fitted. */
      resetView() {
        chart.priceScale('right').applyOptions({ autoScale: true });
        chart.timeScale().resetTimeScale();
        chart.timeScale().fitContent();
      }
    };
  }

  return { create, UP, DOWN };
})();
