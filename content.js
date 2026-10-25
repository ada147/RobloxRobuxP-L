// Content script on roblox.com: adds a navbar icon (styled like Roblox's own white
// line icons) left of the Robux balance. Hovering slides out "P&L Viewer"; clicking
// drops down the extension's popup right below it (the popup page in an iframe);
// the tooltip shows the net P&L of the last 24 hours.

(() => {
  const ITEM_ID = 'rpl-navbar-item';

  // Roblox has shipped a few navbar variants – try the known Robux elements in order.
  const ROBUX_ITEM_SELECTORS = ['#navbar-robux', '#nav-robux-icon', '[id^="nav-robux"]', '.icon-robux-28x28', 'a[href*="/upgrades/robux"]'];
  // The Robux glyph itself – the icon is vertically centered on it.
  const ROBUX_GLYPH_SELECTORS = ['#nav-robux', '.icon-robux-28x28', '[class*="icon-robux"]', '#nav-robux-icon'];

  function findRobuxItem() {
    for (const sel of ROBUX_ITEM_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el.closest('li') || el;
    }
    return null;
  }

  function findRobuxGlyph(robuxItem) {
    for (const sel of ROBUX_GLYPH_SELECTORS) {
      const el = robuxItem.querySelector(sel) || (robuxItem.matches(sel) ? robuxItem : null);
      if (el && el.getBoundingClientRect().height > 0) return el;
    }
    return robuxItem;
  }

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension was reloaded – this page's script is stale
    }
  }

  function buildItem(robuxItem) {
    const item = document.createElement(robuxItem.tagName === 'LI' ? 'li' : 'div');
    item.id = ITEM_ID;
    // Follow the neighbours' flow (Roblox floats its navbar items) without taking their styles,
    // and use the same color as their icons (white on the dark theme).
    const cs = getComputedStyle(robuxItem);
    item.style.float = cs.float;
    item.style.color = cs.color;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rpl-btn';
    btn.title = 'Open P&L Viewer';
    btn.setAttribute('aria-label', 'Open P&L Viewer');
    // Label first: the navbar is right-aligned, so it grows to the left and the icon stays under the mouse.
    btn.innerHTML = `
      <span class="rpl-label">P&amp;L Viewer</span>
      <svg class="rpl-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.4 20.4 7.2v9.6L12 21.6 3.6 16.8V7.2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <polyline points="7.6 14.6 10.4 11.6 12.6 13.6 16.4 9.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="13.8 9.4 16.4 9.4 16.4 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePopover();
    });
    item.append(btn);
    return item;
  }

  // ---- dropdown: the extension's own popup page, embedded below the icon

  const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const POPOVER_WIDTH = 560;
  let popover = null;

  function anchor() {
    return document.querySelector(`#${ITEM_ID} .rpl-btn`);
  }

  function positionPopover() {
    const btn = anchor();
    if (!popover || !btn) return;
    const r = btn.getBoundingClientRect();
    const top = Math.round(r.bottom + 12);
    // Right-aligned to the icon like Roblox's own menus, kept inside the viewport.
    const left = Math.min(Math.max(8, Math.round(r.right + 12 - POPOVER_WIDTH)), window.innerWidth - POPOVER_WIDTH - 8);
    popover.style.top = `${top}px`;
    popover.style.left = `${Math.max(8, left)}px`;
    popover.style.setProperty('--rpl-arrow-x', `${Math.round(r.left + r.width / 2 - Math.max(8, left))}px`);
    popover.querySelector('iframe').style.maxHeight = `${window.innerHeight - top - 12}px`;
  }

  function onOutside(e) {
    if (popover && !popover.contains(e.target) && !e.target.closest?.(`#${ITEM_ID}`)) closePopover();
  }

  function onKey(e) {
    if (e.key === 'Escape') closePopover();
  }

  function openPopover() {
    popover = document.createElement('div');
    popover.id = 'rpl-popover';
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('popup.html?embed=1');
    frame.title = 'P&L Viewer';
    frame.allow = 'clipboard-write';
    frame.style.height = '480px';
    popover.append(frame);
    document.body.append(popover);
    positionPopover();
    setTimeout(() => popover?.classList.add('open'), 0);

    anchor()?.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, { passive: true });
  }

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
    anchor()?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', positionPopover);
    window.removeEventListener('scroll', positionPopover);
  }

  function togglePopover() {
    if (popover) closePopover();
    else openPopover();
  }

  // The embedded page reports its height (so the dropdown fits its content) and asks to close on Esc.
  window.addEventListener('message', (e) => {
    if (e.origin !== EXT_ORIGIN || !popover) return;
    if (e.data?.type === 'rpl-size' && Number.isFinite(e.data.height)) {
      popover.querySelector('iframe').style.height = `${Math.ceil(e.data.height)}px`;
    } else if (e.data?.type === 'rpl-close') {
      closePopover();
    }
  });

  /** Shift the button so its center lines up with the Robux glyph's center, whatever Roblox's CSS does. */
  function align() {
    const item = document.getElementById(ITEM_ID);
    const robuxItem = item?.nextElementSibling;
    if (!item || !robuxItem) return;
    // Measure the item, not the icon: the button is centered in it but carries the
    // (possibly still animating) transform, so its own rect isn't a stable reference.
    const ref = findRobuxGlyph(robuxItem).getBoundingClientRect();
    const own = item.getBoundingClientRect();
    if (!ref.height || !own.height) return;
    const dy = (ref.top + ref.height / 2) - (own.top + own.height / 2);
    item.querySelector('.rpl-btn').style.setProperty('--rpl-dy', `${Math.round(dy * 2) / 2}px`);
  }

  async function updateTooltip() {
    const btn = document.querySelector(`#${ITEM_ID} .rpl-btn`);
    if (!btn) return;
    const res = await send({ type: 'QUICK_PNL' });
    if (!res || !Number.isFinite(res.netPnl)) return;
    const v = Math.round(res.netPnl);
    const pnl = `${v > 0 ? '+' : v < 0 ? '−' : ''}R$ ${Math.abs(v).toLocaleString('en-US')}`;
    btn.title = `P&L Viewer – last 24 h: ${pnl}`;
  }

  function ensureButton() {
    if (document.getElementById(ITEM_ID)) {
      align();
      return;
    }
    const robuxItem = findRobuxItem();
    if (!robuxItem?.parentElement) return;
    robuxItem.parentElement.insertBefore(buildItem(robuxItem), robuxItem);
    align();
    updateTooltip();
  }

  // The navbar is rendered (and re-rendered) by Roblox's scripts – keep the button in place.
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    // setTimeout rather than requestAnimationFrame: rAF doesn't run in background tabs.
    setTimeout(() => {
      scheduled = false;
      ensureButton();
    }, 50);
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('resize', align);
  document.fonts?.ready.then(align);
  ensureButton();

  // Refresh the tooltip after each sync.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.syncState && !changes.syncState.newValue?.running) updateTooltip();
    });
  } catch { /* stale script */ }
})();
