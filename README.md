# Robux P&L Dashboard (Chrome Extension, MV3)

Reads your Roblox transactions through the economy API, stores the full history locally in IndexedDB (Dexie.js) and shows a profit & loss statement plus a Robux balance dashboard in the popup.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 config (`storage`, `alarms`, `unlimitedStorage`, host access to `*.roblox.com`, `*.rbxcdn.com` for the avatar on share images, `api.frankfurter.dev` for the exchange rate) |
| `db.js` | Dexie schema (`transactions`, `syncMeta`) and DB helpers |
| `api.js` | Roblox API client with a self-learning rate limiter (see *Rate limits*) |
| `pnl.js` | P&L engine: classification, periods, metrics, chart series |
| `background.js` | Service worker: deep scan / incremental sync, auto-sync every 30 min, daily USD→EUR rate |
| `popup.html` / `popup.css` / `popup.js` | Dashboard – compact popup with the essentials, full-width view in a tab (⤢) |
| `share.js` | Renders the 1200×675 share image ("flex card") |
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

Roblox limits each API to *N requests per time window*. Instead of guessing, the client learns N:

- Each Roblox host gets its own lane, starting at 300 ms between requests.
- On the first 429 it counts how many requests succeeded in the last 60 s and sets the budget to ~85 % of that. From then on requests are spread evenly (60 s / budget) and never exceed the budget in any rolling minute – in practice one 429 to learn the limit, then none.
- The learned budget is saved, so later syncs start at a safe pace right away. After 150 requests without a 429 it tries one more request per minute, but never back up to a rate that was limited. The current value is shown under **Settings → Data**.
- `x-ratelimit-remaining` / `x-ratelimit-reset` and `Retry-After` headers are honoured when Roblox sends them.
- Opening the popup syncs at most every 10 minutes; the background syncs every 30 minutes.
- If Roblox keeps limiting anyway, the sync pauses and resumes automatically after 5 minutes – no progress is lost. Waiting times count down live in the status line.

## Share image

The image button opens a share dialog: pick the period below the preview, optionally hide your balance, then **Download PNG** or **Copy image**. The card shows your avatar, display name and @username top right, net P&L, DevEx value, the cumulative P&L curve and key stats, with the extension's icon and name bottom right.

## Metrics

- **Net profit** = all income as it reaches you (sales are already net of the marketplace fee)
- **Gross revenue** = sales grossed up (`net / (1 − fee)`) + other income
- **Marketplace fees** = gross sales − net sales
- **Total spent** = purchases + ads + negative trades
- **Net P&L** = net profit − total spent
- **DevEx value** = net P&L × DevEx rate (default $0.0035, configurable). EUR uses the live ECB rate from frankfurter.dev (updated daily) unless you switch to a manual rate.
- Percentages under the numbers compare with the previous period of the same length.
- Robux purchases, Premium stipends and DevEx cash-outs are tracked separately and don't affect P&L.
- The **balance history** is estimated backwards from the live balance and the stored transactions.

All data stays in your browser. The extension only uses your existing roblox.com session; the only non-Roblox request is fetching the public USD→EUR rate, which contains no personal data.
