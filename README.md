# NSE Research — GitHub Pages + Cloudflare Worker, Free Near-Live Version

This version is designed for mobile use without localhost.

Architecture:

```text
Mobile browser → GitHub Pages frontend → Cloudflare Worker proxy → Yahoo Finance public chart endpoint + NSE symbol master
```

## Reality check

This is the free route. It is **near-live / possibly delayed**, not an exchange-certified realtime NSE feed. Yahoo/NSE public endpoints can be cached, delayed, throttled, or changed.

Use it for research and watchlists. Do not treat it as a trading terminal.

## Files

- `index.html` — upload to GitHub Pages.
- `worker.js` — deploy to Cloudflare Workers.
- `wrangler.toml` — optional if deploying with Wrangler.

## Setup

1. Create a Cloudflare Worker.
2. Paste the full contents of `worker.js` and deploy.
3. Copy your Worker URL, for example:

```text
https://nse-research-api.yourname.workers.dev
```

4. Open `index.html` and replace:

```js
const APP_API_BASE = 'https://REPLACE_WITH_YOUR_WORKER_URL';
```

with:

```js
const APP_API_BASE = 'https://nse-research-api.yourname.workers.dev';
```

5. Upload `index.html` to a GitHub repo and enable GitHub Pages.
6. Open your GitHub Pages URL on mobile.

## Test Worker endpoints

Open these in your browser:

```text
/ api/health
/ api/search?q=reliance
/ api/quote?symbol=RELIANCE
```

Use the full Worker domain before each path.

Example:

```text
https://nse-research-api.yourname.workers.dev/api/quote?symbol=RELIANCE
```

## What changed in this version

- Auto-refreshes the selected stock every 15 seconds.
- Adds manual Refresh button.
- Shows source, update time, and free near-live/delayed mode in the KPI strip.
- Removes fake generated values for quote data.
- Uses Cloudflare Worker for quote and symbol search calls.
- Loads NSE stock suggestions from the NSE equity master when available.
- Popular stock cards fetch via the Worker, not direct browser calls.

