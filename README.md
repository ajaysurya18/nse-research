# NSE Research — NSE-primary quote fix

Your GitHub frontend is already hard-coded to:
https://nse-research-api.jamunjeera12.workers.dev

Important: Upload `index.html` to GitHub Pages as `index.html`.
Then replace the code in your Cloudflare Worker with the full contents of `worker.js` and click Deploy.

This Worker uses NSE official public quote data first for price/open/high/low/volume/VWAP, and Yahoo Finance only for chart history fallback.

Test after deploy:
https://nse-research-api.jamunjeera12.workers.dev/api/health
https://nse-research-api.jamunjeera12.workers.dev/api/quote?symbol=RELIANCE&force=1
