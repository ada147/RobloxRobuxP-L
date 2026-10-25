# DevForum post – Robux P&L

**Category:** Community Resources (or Help and Feedback → Creations Feedback if you mainly want feedback)
**Tags:** `tool`, `analytics`, `open-source`

## Title (pick one)

1. **Robux P&L – a free, open-source profit & loss dashboard for your Robux (Chrome extension)**
2. Track your Robux like a stock: Robux P&L, an open-source earnings dashboard
3. [Open Source] Robux P&L – see what you actually earn, spend and cash out on Roblox

---

Hey everyone! 👋

I always wanted a clear answer to a simple question: **how much Robux did I actually make this week – and where did it go?** The built-in transactions page is a long list, so I built a small Chrome extension that turns your transaction history into a proper **profit & loss dashboard**.

It's free, open source (GPL-3.0) and everything stays in your own browser.

> 📷 *[Screenshot: 01-popup.png – the popup]*

## ✨ Features

- **Net P&L at a glance** – gross revenue, net profit (after the marketplace fee), total spent, marketplace fees and your net P&L, for **1 day, 1 week, 1 month, 1 year or all time**, each compared with the previous period.
- **DevEx value** – see what your balance and your P&L are worth in USD or EUR (DevEx rate is configurable, EUR uses the daily ECB rate).
- **Trading-style chart** – your Robux balance as candlesticks (or line / area) with volume, a crosshair and a hover box with Open / High / Low / Close, like a stock chart. Switch to cumulative net P&L with one click.
- **Groups you own** – switch between yourself and each group you own. Every group gets its own dashboard: group funds, its own P&L, chart and top items. Member payouts aren't counted twice.
- **Breakdown** – by transaction type (sales, premium payouts, group payouts, purchases, ad spend, DevEx …), top-selling items and recent transactions.
- **Share images** – generate a clean P&L card for any period, download it or copy it to the clipboard.
- **Right in the Roblox navbar** – a small icon next to your Robux balance opens the dashboard on roblox.com (hover it to see your last 24 h).
- **CSV export** of your full transaction history.

> 📷 *[Screenshot: 04-full-dashboard.png – full dashboard]*
>
> 📷 *[Screenshot: 05-chart-hover.png – chart with hover info]*
>
> 📷 *[Screenshot: 02-account-switcher.png – switching between you and your groups]*
>
> 📷 *[Screenshot: 09-share-card-1y.png – share image]*

## 🔒 Privacy & safety

I know browser extensions + Roblox accounts is a sensitive topic, so here's exactly what it does:

- It only **reads** data from Roblox's own web APIs (your balance, your transaction history, your groups) using the roblox.com login your browser already has. It **never reads, stores or sends your cookie** anywhere.
- It only makes **GET requests** – it can't buy, trade, post or change anything on your account.
- All transactions are stored **locally in your browser** (IndexedDB). Nothing is uploaded to any server.
- The only non-Roblox requests are the public USD → EUR exchange rate and a once-a-day check for a newer release on GitHub (no personal data in either).
- No remote code, no analytics, no tracking. The full source is on GitHub under the **GPL-3.0** license – feel free to read every line, and any fork has to stay open source too.

This project is not affiliated with or endorsed by Roblox Corporation.

## ⚙️ How it works

- **First run:** a deep scan reads your entire transaction history (on big accounts this can take a few minutes – it resumes where it stopped if you close the browser).
- **After that:** it only fetches new transactions, automatically every 30 minutes or when you open it.
- **Rate limits:** Roblox limits how fast its APIs can be called. The extension learns that limit after the first 429 and stays below it, so syncs don't get stuck in rate-limit loops. Waits are shown with a live countdown.
- **Numbers:** sales arrive net of the marketplace fee, so gross revenue is calculated from the net amount (30 % by default, configurable). Robux purchases, Premium stipends and DevEx cash-outs are shown separately and don't count as profit or loss. The balance history in the chart is reconstructed from your current balance and transactions, so treat it as an estimate.

## 📦 Install

Robux P&L is distributed for free through GitHub (no web store), so you add it yourself – it takes about a minute:

1. Download the latest `robux-pnl-vX.Y.Z.zip` from **https://github.com/alphabjarnegit/RobloxRobuxP-L/releases/latest**
2. Unzip it into a folder you keep (Chrome loads the extension from there).
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder.
5. Pin the extension, make sure you're logged in on roblox.com and open it – the first sync starts automatically.

**Updating:** when a new version is released, the extension shows an **Update** badge. Download the new ZIP, unzip it into the same folder (replace the files) and click ↻ on `chrome://extensions`. Your synced data is kept.

Built and tested for Chrome. Other Chromium browsers (Edge, Brave, Opera) should work too, but I haven't tested them yet – let me know!

## 🗺️ What's next

- More stats per game / per item
- Your ideas!

I'd love to hear your feedback: what's missing, what's confusing, what would make this useful for your games or groups? Bug reports and pull requests on GitHub are very welcome. 🙏

---

## Screenshot files (`docs/screenshots/`)

Upload these where the placeholders are:

| File | Shows |
|---|---|
| `01-popup.png` | The popup (your account, last 30 days) |
| `02-account-switcher.png` | Switching between you and your groups |
| `03-group-dashboard.png` | A group's dashboard (group funds, P&L) |
| `04-full-dashboard.png` | Full dashboard with candlestick chart |
| `05-chart-hover.png` | Chart with the hover box (O/H/L/C, volume) |
| `06-full-area-1y.png` | 1-year view, area chart |
| `07-share-dialog.png` | Share dialog |
| `08-share-card.png` / `09-share-card-1y.png` | Generated share images (30 days / 12 months) |
| `10-share-dialog-1y.png` | Share dialog, 12 months |

All screenshots use **demo data** ("Demo Creator", "Demo Studio") – no real account. Recommended extra: a screenshot of the navbar icon on the real roblox.com (take it yourself with your account, hovered so "P&L Viewer" is visible).
