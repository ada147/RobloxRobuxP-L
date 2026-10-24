# Robux P&L Dashboard (Chrome Extension, MV3)

Reads your Roblox transactions through the economy API, stores the full history locally in IndexedDB (Dexie.js) and shows a profit & loss statement plus a Robux balance dashboard in the popup.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 config (`storage`, `alarms`, `unlimitedStorage`, host access to `*.roblox.com`) |
| `db.js` | Dexie schema (`transactions`, `syncMeta`) and DB helpers |
| `api.js` | Roblox API client with per-host pacing (see *Rate limits*) |
| `pnl.js` | P&L engine: classification, periods, metrics, chart series |
| `background.js` | Service worker: deep scan / incremental sync, auto-sync every 30 min |
| `popup.html` / `popup.css` / `popup.js` | Dashboard (1D / 7D / 1M / 1Y / All, Chart.js) |
| `lib/` | Dexie 4.0.8 and Chart.js 4.4.4, bundled locally (MV3 forbids remote code) |

## Install (unpacked extension)

1. Open Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** → select this folder (`RobloxP&L`)
4. Pin the extension via the puzzle icon in the toolbar
5. Log in on **roblox.com**, then open the popup – the first deep scan starts automatically

After code changes, click ↻ (reload) on the extension's card in `chrome://extensions`. Service worker logs: click **Service worker** on the card → DevTools console. Popup logs: right-click inside the popup → **Inspect**.

## How sync works

- **Active types only:** one request to `/v2/users/{id}/transaction-types` tells which types the account has ever used; the others are never queried.
- **Deep scan** (first run, per type): pages through the full history via `nextPageCursor`. The cursor is saved after every page, so an interrupted scan resumes where it stopped.
- **Incremental** (afterwards): fetches pages from the newest entry until it reaches a stored transaction that is no longer pending. Pending sales get updated once they clear.
- Types the API rejects with HTTP 400 are remembered and skipped (a full deep scan retries them).

## Rate limits

- Each Roblox host gets its own pace, starting at 300 ms between requests.
- `x-ratelimit-remaining` / `x-ratelimit-reset` headers are honoured up front: when the quota is used up, the extension waits for it to refill instead of running into a 429.
- Every 429 doubles the spacing (max 15 s); 20 successful requests in a row lower it again. The learned pace is saved for the next run.
- Retries back off 5 s → 10 s → 20 s → 40 s → 80 s (or use `Retry-After`). If Roblox still limits, the sync pauses and resumes automatically after 5 minutes – no progress is lost.

## Metrics

- **Net profit** = all income as it reaches you (sales are already net of the marketplace fee)
- **Gross revenue** = sales grossed up (`net / (1 − fee)`) + other income
- **Marketplace fees** = gross sales − net sales
- **Total spent** = purchases + ads + negative trades
- **Net P&L** = net profit − total spent
- **DevEx value** = net P&L × DevEx rate (default $0.0035, configurable, with optional EUR conversion)
- Robux purchases, Premium stipends and DevEx cash-outs are tracked separately and don't affect P&L.
- The **balance history** is estimated backwards from the live balance and the stored transactions.

All data stays in your browser. The extension only uses your existing roblox.com session and sends nothing to third parties.
