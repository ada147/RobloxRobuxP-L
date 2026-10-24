// Renders the shareable P&L "flex card" (1200×675 PNG) onto a canvas.
// Pure drawing – the popup passes in the data and its own number formatters.

const ShareCard = (() => {
  const W = 1200;
  const H = 675;
  const PAD = 60;
  const C = {
    text: '#f4f4f6',
    muted: '#8a8a94',
    green: '#2dd4a7',
    red: '#ff6b7d',
    accent: '#8b8bff',
    pill: 'rgba(255, 255, 255, 0.045)',
    border: 'rgba(255, 255, 255, 0.08)'
  };
  const FAMILY = '"Inter", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
  const font = (weight, size) => `${weight} ${size}px ${FAMILY}`;

  /** Hexagon Robux mark, same geometry as the UI icon (24-unit box). */
  function robuxIcon(ctx, x, y, size, color) {
    const s = size / 24;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(12, 2.2); ctx.lineTo(20.5, 7); ctx.lineTo(20.5, 17);
    ctx.lineTo(12, 21.8); ctx.lineTo(3.5, 17); ctx.lineTo(3.5, 7);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(9.2, 9.2, 5.6, 5.6, 1);
    ctx.fill();
    ctx.restore();
  }

  /** Largest font size (down to minSize) at which text fits maxWidth. */
  function fit(ctx, text, weight, maxSize, maxWidth, minSize = 18) {
    let size = maxSize;
    ctx.font = font(weight, size);
    while (size > minSize && ctx.measureText(text).width > maxWidth) {
      size -= 2;
      ctx.font = font(weight, size);
    }
    return size;
  }

  function glow(ctx, x, y, r, rgb, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function background(ctx, positive) {
    const base = ctx.createLinearGradient(0, 0, W, H);
    base.addColorStop(0, '#0e0e10');
    base.addColorStop(1, '#1a1a1f');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    glow(ctx, 120, 40, 560, '108, 108, 255', 0.22);
    glow(ctx, W - 80, H + 40, 600, positive ? '45, 212, 167' : '255, 107, 125', 0.15);

    // Inner frame gives the image a card edge when posted on light backgrounds too.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(14, 14, W - 28, H - 28, 30);
    ctx.stroke();
  }

  function avatar(ctx, img, cx, cy, r, letter) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#26262b';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    if (img) {
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    } else {
      ctx.fillStyle = C.muted;
      ctx.font = font(700, r);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, cx, cy + 2);
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  function chart(ctx, values, x, y, w, h, color) {
    if (values.length < 2) return;
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const span = max - min || 1;
    const px = (i) => x + (i / (values.length - 1)) * w;
    const py = (v) => y + h - ((v - min) / span) * h;

    // zero line
    ctx.save();
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, py(0));
    ctx.lineTo(x + w, py(0));
    ctx.stroke();
    ctx.restore();

    const line = new Path2D();
    values.forEach((v, i) => {
      const X = px(i), Y = py(v);
      if (i === 0) line.moveTo(X, Y);
      else {
        // smooth with horizontal-tangent bezier segments
        const pX = px(i - 1), pY = py(values[i - 1]);
        const mid = (pX + X) / 2;
        line.bezierCurveTo(mid, pY, mid, Y, X, Y);
      }
    });

    const area = new Path2D(line);
    area.lineTo(px(values.length - 1), py(0));
    area.lineTo(px(0), py(0));
    area.closePath();
    const fill = ctx.createLinearGradient(0, y, 0, y + h);
    fill.addColorStop(0, `${color}55`);
    fill.addColorStop(1, `${color}00`);
    ctx.fillStyle = fill;
    ctx.fill(area);

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(line);
    ctx.restore();

    const lx = px(values.length - 1), ly = py(values[values.length - 1]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx, ly, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#141417';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function pill(ctx, x, y, w, h, label, value, color) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = 'rgba(28, 28, 32, 0.92)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 20);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 20);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.muted;
    ctx.font = font(600, 17);
    ctx.fillText(label, x + 24, y + 40);
    ctx.fillStyle = color || C.text;
    fit(ctx, value, 750, 32, w - 48);
    ctx.fillText(value, x + 24, y + 84);
  }

  /**
   * d = { displayName, username, avatar, logo, periodName, rangeText, metrics,
   *       cumulative, balance, showBalance, robux(n, opts), money(usd) }
   */
  function render(canvas, d) {
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const m = d.metrics;
    const positive = m.netPnl >= 0;
    const accent = positive ? C.green : C.red;

    background(ctx, positive);

    // --- top left: title + period
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.muted;
    ctx.font = font(700, 16);
    ctx.letterSpacing = '3px';
    ctx.fillText(`NET P&L · ${d.periodName.toUpperCase()}`, PAD, PAD + 22);
    ctx.letterSpacing = '0px';
    ctx.font = font(500, 18);
    ctx.fillStyle = 'rgba(244, 244, 246, 0.5)';
    ctx.fillText(d.rangeText, PAD, PAD + 52);

    // --- top right: avatar + names
    const r = 36;
    const acx = W - PAD - r, acy = PAD + 30;
    avatar(ctx, d.avatar, acx, acy, r, (d.displayName || '?').charAt(0).toUpperCase());
    ctx.textAlign = 'right';
    ctx.fillStyle = C.text;
    fit(ctx, d.displayName, 700, 26, 360);
    ctx.fillText(d.displayName, acx - r - 20, acy + 2);
    ctx.fillStyle = C.muted;
    ctx.font = font(500, 18);
    ctx.fillText(`@${d.username}`, acx - r - 20, acy + 28);

    // --- hero number
    const hero = d.robux(m.netPnl, { sign: true });
    ctx.textAlign = 'left';
    const size = fit(ctx, hero, 800, 100, 470, 40);
    const iconSize = Math.round(size * 0.72);
    robuxIcon(ctx, PAD, 268 - iconSize * 0.86, iconSize, accent);
    ctx.save();
    ctx.shadowColor = positive ? 'rgba(45, 212, 167, 0.45)' : 'rgba(255, 107, 125, 0.45)';
    ctx.shadowBlur = 40;
    ctx.fillStyle = accent;
    ctx.font = font(800, size);
    ctx.fillText(hero.replace('R$ ', ''), PAD + iconSize + 16, 268);
    ctx.restore();

    ctx.fillStyle = C.muted;
    ctx.font = font(500, 24);
    ctx.fillText(`≈ ${d.money(m.devexUsd)} DevEx value`, PAD, 318);

    // --- chart on the right
    chart(ctx, d.cumulative, 640, 150, W - PAD - 640 - 10, 230, positive ? '#2dd4a7' : '#ff6b7d');

    // --- stat pills
    const stats = [
      ['Gross revenue', d.robux(m.grossRevenue)],
      ['Net profit', d.robux(m.netProfit), C.green],
      ['Total spent', d.robux(m.totalSpent), C.red]
    ];
    if (d.showBalance && Number.isFinite(d.balance)) stats.push(['Balance', d.robux(d.balance)]);
    const gap = 20;
    const pw = (W - PAD * 2 - gap * (stats.length - 1)) / stats.length;
    stats.forEach(([label, value, color], i) => pill(ctx, PAD + i * (pw + gap), 418, pw, 112, label, value, color));

    // --- footer: date left, extension brand bottom right
    const fy = H - PAD + 6;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(138, 138, 148, 0.8)';
    ctx.font = font(500, 16);
    ctx.fillText(`Generated ${new Date().toLocaleDateString('en-US', { dateStyle: 'medium' })}`, PAD, fy);

    ctx.textAlign = 'right';
    ctx.fillStyle = C.text;
    ctx.font = font(700, 22);
    ctx.fillText('Robux P&L', W - PAD, fy);
    const tw = ctx.measureText('Robux P&L').width;
    if (d.logo) {
      const ls = 38;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 16;
      ctx.drawImage(d.logo, W - PAD - tw - 12 - ls, fy - ls + 9, ls, ls);
      ctx.restore();
    }
  }

  return { W, H, render };
})();
