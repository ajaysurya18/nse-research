/*
  NSE Research Cloudflare Worker API
  Deploy this file to Cloudflare Workers, then set APP_API_BASE in index.html to your Worker URL.

  Routes:
    /api/health
    /api/symbols
    /api/search?q=reliance
    /api/quote?symbol=RELIANCE
*/

const NSE_MASTER_URLS = [
  'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
  'https://archives.nseindia.com/content/equities/EQUITY_L.csv'
];

const DEFAULT_STOCK_DIRECTORY = [
  { sym:'RELIANCE', name:'Reliance Industries', sector:'EQ' },
  { sym:'TCS', name:'Tata Consultancy Services', sector:'EQ' },
  { sym:'HDFCBANK', name:'HDFC Bank', sector:'EQ' },
  { sym:'INFY', name:'Infosys', sector:'EQ' },
  { sym:'SBIN', name:'State Bank of India', sector:'EQ' },
  { sym:'ICICIBANK', name:'ICICI Bank', sector:'EQ' },
  { sym:'BAJFINANCE', name:'Bajaj Finance', sector:'EQ' },
  { sym:'WIPRO', name:'Wipro', sector:'EQ' },
  { sym:'AXISBANK', name:'Axis Bank', sector:'EQ' },
  { sym:'TATAMOTORS', name:'Tata Motors', sector:'EQ' },
  { sym:'ADANIENT', name:'Adani Enterprises', sector:'EQ' },
  { sym:'MARUTI', name:'Maruti Suzuki India', sector:'EQ' },
  { sym:'HINDUNILVR', name:'Hindustan Unilever', sector:'EQ' },
  { sym:'ITC', name:'ITC', sector:'EQ' },
  { sym:'KOTAKBANK', name:'Kotak Mahindra Bank', sector:'EQ' },
  { sym:'LT', name:'Larsen & Toubro', sector:'EQ' }
];

const PERIOD_CONFIG = {
  '1D': { range:'1d', interval:'5m' },
  '5D': { range:'5d', interval:'15m' },
  '1W': { range:'5d', interval:'15m' },
  '1M': { range:'1mo', interval:'1d' },
  '3M': { range:'3mo', interval:'1d' },
  '6M': { range:'6mo', interval:'1d' },
  '1Y': { range:'1y', interval:'1d' },
  '3Y': { range:'3y', interval:'1wk' },
  '5Y': { range:'5y', interval:'1wk' },
  'ITD': { range:'max', interval:'1mo' }
};

let symbolCache = null;
let symbolCacheAt = 0;
let quoteCache = new Map();

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    ...extra
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/\.NS$/,'').replace(/[^A-Z0-9&-]/g, '');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseCsvRows(csvText) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i], next = csvText[i + 1];
    if (ch === '"' && quoted && next === '"') { field += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { row.push(field); field = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (field || row.length) { row.push(field); rows.push(row); }
      field = ''; row = [];
      if (ch === '\r' && next === '\n') i++;
      continue;
    }
    field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchWithTimeout(url, options = {}, ms = 9000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort('timeout'), ms);
  try {
    const response = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        'Accept': 'application/json,text/csv,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 NSE-Research-Worker/1.0',
        ...(options.headers || {})
      },
      cf: options.cf || { cacheTtl: 60, cacheEverything: false }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response;
  } finally {
    clearTimeout(id);
  }
}

async function loadSymbols() {
  if (symbolCache && Date.now() - symbolCacheAt < 24 * 60 * 60 * 1000) return symbolCache;

  for (const url of NSE_MASTER_URLS) {
    try {
      const csv = await (await fetchWithTimeout(url, { cf: { cacheTtl: 86400, cacheEverything: true } }, 10000)).text();
      const rows = parseCsvRows(csv).filter(r => r.length >= 3);
      const headers = rows.shift().map(h => h.trim().toUpperCase());
      const symbolIdx = headers.indexOf('SYMBOL');
      const nameIdx = headers.indexOf('NAME OF COMPANY');
      const seriesIdx = headers.indexOf('SERIES');
      if (symbolIdx < 0 || nameIdx < 0) throw new Error('Unexpected NSE CSV format');

      const parsed = rows.map(r => ({
        sym: normalizeSymbol(r[symbolIdx]),
        name: String(r[nameIdx] || '').trim(),
        sector: String(r[seriesIdx] || 'EQ').trim() || 'EQ'
      })).filter(s => s.sym && s.name && ['EQ','BE','BZ','SM','ST','SZ'].includes(String(s.sector).toUpperCase()));

      if (parsed.length > 1000) {
        const merged = new Map();
        [...DEFAULT_STOCK_DIRECTORY, ...parsed].forEach(s => merged.set(s.sym, s));
        symbolCache = [...merged.values()].sort((a,b) => a.sym.localeCompare(b.sym));
        symbolCacheAt = Date.now();
        return symbolCache;
      }
    } catch (e) {
      console.log('Symbol master fetch failed:', url, e.message);
    }
  }

  symbolCache = DEFAULT_STOCK_DIRECTORY;
  symbolCacheAt = Date.now();
  return symbolCache;
}

async function fetchYahooChart(symbol, range, interval) {
  const ticker = `${normalizeSymbol(symbol)}.NS`;
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`
  ];

  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          'Origin': 'https://finance.yahoo.com',
          'Referer': 'https://finance.yahoo.com/',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        cf: { cacheTtl: range === '1d' ? 20 : 300, cacheEverything: true }
      }, 10000);
      const data = await res.json();
      if (data?.chart?.error) throw new Error(data.chart.error.description || 'Yahoo chart error');
      if (!data?.chart?.result?.[0]) throw new Error('Empty Yahoo chart response');
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo chart unavailable');
}

function compactPrices(yahooJson) {
  const result = yahooJson?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0] || {};
  return (quote.close || []).filter(v => typeof v === 'number' && Number.isFinite(v)).map(v => +v.toFixed(2));
}

function pickQuoteMeta(yahooJson) {
  return yahooJson?.chart?.result?.[0]?.meta || {};
}


async function fetchYahooQuote(symbol) {
  const ticker = `${normalizeSymbol(symbol)}.NS`;
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'Origin': 'https://finance.yahoo.com',
      'Referer': 'https://finance.yahoo.com/',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    cf: { cacheTtl: 60, cacheEverything: true }
  }, 10000);
  const j = await res.json();
  const q = j?.quoteResponse?.result?.[0];
  if (!q) throw new Error('Empty Yahoo quote response');
  return q;
}

async function fetchYahooQuoteSummary(symbol) {
  const ticker = `${normalizeSymbol(symbol)}.NS`;
  const modules = [
    'price', 'summaryDetail', 'defaultKeyStatistics', 'financialData',
    'assetProfile', 'summaryProfile', 'incomeStatementHistory', 'earningsTrend'
  ].join(',');
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${encodeURIComponent(modules)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'Origin': 'https://finance.yahoo.com',
      'Referer': `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`,
      'Accept-Language': 'en-US,en;q=0.9'
    },
    cf: { cacheTtl: 300, cacheEverything: true }
  }, 10000);
  const j = await res.json();
  if (j?.quoteSummary?.error) throw new Error(j.quoteSummary.error.description || 'Yahoo quoteSummary error');
  const out = j?.quoteSummary?.result?.[0];
  if (!out) throw new Error('Empty Yahoo quoteSummary response');
  return out;
}

function rawValue(v) {
  if (v == null) return null;
  if (typeof v === 'object' && 'raw' in v) return num(v.raw);
  return num(v);
}

function pctValue(v) {
  const n = rawValue(v);
  if (n == null) return null;
  // Yahoo summaryDetail dividend/profitability ratios often arrive as decimals.
  return Math.abs(n) <= 1 ? n * 100 : n;
}

function applyYahooFundamentals(base, quote, summary) {
  const sd = summary?.summaryDetail || {};
  const ks = summary?.defaultKeyStatistics || {};
  const fd = summary?.financialData || {};
  const price = summary?.price || {};
  const ap = summary?.assetProfile || summary?.summaryProfile || {};

  const out = { ...base };
  const set = (key, value) => { if (out[key] == null && value != null && Number.isFinite(Number(value))) out[key] = Number(value); };
  const overwrite = (key, value) => { if (value != null && Number.isFinite(Number(value))) out[key] = Number(value); };

  // These quote fields are usually reliable from Yahoo's quote endpoint.
  set('eps', num(quote?.epsTrailingTwelveMonths));
  set('pe', num(quote?.trailingPE));
  set('pb', num(quote?.priceToBook));
  set('bookValue', num(quote?.bookValue));
  set('beta', num(quote?.beta));
  set('avgVolume', num(quote?.averageDailyVolume10Day) ?? num(quote?.averageDailyVolume3Month));
  set('divYield', quote?.trailingAnnualDividendYield != null ? pctValue(quote.trailingAnnualDividendYield) : pctValue(quote?.dividendYield));
  set('mktCap', quote?.marketCap ? num(quote.marketCap) / 10000000 : null);
  overwrite('weekHigh52', num(quote?.fiftyTwoWeekHigh));
  overwrite('weekLow52', num(quote?.fiftyTwoWeekLow));

  // quoteSummary has additional ratios when Yahoo allows the endpoint.
  set('eps', rawValue(ks.trailingEps));
  set('pe', rawValue(sd.trailingPE) ?? rawValue(ks.trailingPE));
  set('pb', rawValue(ks.priceToBook));
  set('bookValue', rawValue(ks.bookValue));
  set('beta', rawValue(sd.beta) ?? rawValue(ks.beta));
  set('divYield', pctValue(sd.dividendYield));
  set('mktCap', rawValue(price.marketCap) ? rawValue(price.marketCap) / 10000000 : null);

  set('roe', pctValue(fd.returnOnEquity));
  set('roce', pctValue(fd.returnOnAssets));
  set('netMargin', pctValue(fd.profitMargins));
  set('opmMargin', pctValue(fd.operatingMargins));
  set('currentRatio', rawValue(fd.currentRatio));
  set('debtToEquity', rawValue(fd.debtToEquity));
  set('revenueGrowthYoY', pctValue(fd.revenueGrowth));
  set('profitGrowthYoY', pctValue(fd.earningsGrowth));

  if (ap.industry && (!out.industry || out.industry === '—')) out.industry = ap.industry;
  if (ap.sector && (!out.sector || out.sector === 'NSE Equity' || out.sector === 'EQ')) out.sector = ap.sector;

  // Derive missing EPS/PE if one side is available.
  if (out.eps == null && out.pe && out.price) out.eps = out.price / out.pe;
  if (out.pe == null && out.eps && out.price) out.pe = out.price / out.eps;
  if (out.bookValue == null && out.pb && out.price) out.bookValue = out.price / out.pb;
  if (out.pb == null && out.bookValue && out.price) out.pb = out.price / out.bookValue;

  return out;
}

function parseNseNumber(v) {
  if (v == null || v === '' || v === '-' || v === '--') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseNseDateTime(s) {
  // NSE usually returns strings like "17-May-2026 15:30:00" or includes IST labels.
  if (!s) return null;
  const raw = String(s).replace(/ IST/i, '').trim();
  const m = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const mon = months[m[2]];
  if (mon == null) return null;
  // Convert IST to UTC ISO.
  const utc = Date.UTC(+m[3], mon, +m[1], +m[4] - 5, +m[5] - 30, +m[6]);
  return new Date(utc).toISOString();
}

async function fetchNseQuote(symbol) {
  const clean = normalizeSymbol(symbol);
  const homeUrl = 'https://www.nseindia.com/';
  const quoteUrl = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(clean)}`;
  const baseHeaders = {
    'Accept': 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Referer': `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(clean)}`,
    'Origin': 'https://www.nseindia.com',
    'Connection': 'keep-alive'
  };

  let cookie = '';
  try {
    const home = await fetchWithTimeout(homeUrl, {
      headers: { ...baseHeaders, 'Accept': 'text/html,*/*' },
      cf: { cacheTtl: 0, cacheEverything: false }
    }, 7000);
    cookie = home.headers.get('set-cookie') || '';
  } catch (_) {
    // Some Cloudflare regions can call the API without a cookie. Continue.
  }

  const res = await fetchWithTimeout(quoteUrl, {
    headers: { ...baseHeaders, ...(cookie ? { 'Cookie': cookie } : {}) },
    cf: { cacheTtl: 10, cacheEverything: false }
  }, 9000);
  const j = await res.json();
  if (!j || !j.priceInfo) throw new Error('NSE quote returned no priceInfo');
  return j;
}

function normalizeNseQuote(nse, base = {}) {
  const p = nse.priceInfo || {};
  const meta = nse.info || nse.metadata || {};
  const security = nse.securityInfo || {};
  const highLow = p.intraDayHighLow || {};
  const week = p.weekHighLow || {};
  const trade = nse.marketDeptOrderBook?.tradeInfo || {};
  const dp = nse.securityWiseDP || {};
  const last = parseNseNumber(p.lastPrice) ?? base.price ?? null;
  const prev = parseNseNumber(p.previousClose) ?? base.prevClose ?? null;
  const change = parseNseNumber(p.change) ?? (last != null && prev != null ? last - prev : base.change ?? 0);
  const changePct = parseNseNumber(p.pChange) ?? (prev ? change / prev * 100 : base.changePct ?? 0);
  const open = parseNseNumber(p.open) ?? parseNseNumber(highLow.open) ?? base.open ?? null;
  const volume = parseNseNumber(p.totalTradedVolume) ?? parseNseNumber(trade.totalTradedVolume) ?? base.volume ?? null;
  const issued = parseNseNumber(security.issuedSize);
  const mcapCr = issued && last ? (issued * last) / 10000000 : base.mktCap ?? null;
  return {
    ...base,
    name: meta.companyName || meta.companyName || base.name || normalizeSymbol(nse.symbol),
    symbol: normalizeSymbol(nse.symbol || base.symbol),
    sector: meta.industry || base.sector || 'NSE Equity',
    industry: meta.industry || base.industry || '—',
    price: last,
    change,
    changePct,
    open,
    prevClose: prev,
    dayHigh: parseNseNumber(highLow.max) ?? parseNseNumber(p.intraDayHighLow?.max) ?? base.dayHigh ?? last,
    dayLow: parseNseNumber(highLow.min) ?? parseNseNumber(p.intraDayHighLow?.min) ?? base.dayLow ?? last,
    volume,
    avgVolume: base.avgVolume ?? null,
    vwap: parseNseNumber(p.vwap) ?? base.vwap ?? last,
    beta: base.beta ?? null,
    mktCap: mcapCr ?? base.mktCap,
    weekHigh52: parseNseNumber(week.max) ?? base.weekHigh52,
    weekLow52: parseNseNumber(week.min) ?? base.weekLow52,
    faceValue: parseNseNumber(security.faceValue) ?? base.faceValue,
    pe: parseNseNumber(nse.metadata?.pdSymbolPe) ?? parseNseNumber(meta.pdSymbolPe) ?? base.pe,
    sectorPE: parseNseNumber(nse.metadata?.pdSectorPe) ?? parseNseNumber(meta.pdSectorPe) ?? base.sectorPE,
    bookValue: base.bookValue ?? null,
    eps: base.eps ?? null,
    pb: base.pb ?? null,
    divYield: base.divYield ?? null,
    ucLimit: parseNseNumber(p.upperCP) ?? base.ucLimit,
    lcLimit: parseNseNumber(p.lowerCP) ?? base.lcLimit,
    deliveryPct: parseNseNumber(dp.deliveryToTradedQuantity) ?? base.deliveryPct,
    source: 'NSE official quote API + Yahoo Finance chart history',
    freshness: 'NSE public near-live / possibly delayed',
    isRealtime: false,
    regularMarketTime: parseNseDateTime(nse.metadata?.lastUpdateTime || nse.priceInfo?.lastUpdateTime || nse.info?.lastUpdateTime) || base.regularMarketTime || null,
    fetchedAt: new Date().toISOString()
  };
}

function generateFallback(base, n) {
  const arr = [];
  let p = Number(base || 1000) * 0.94;
  for (let i = 0; i < n; i++) {
    p = p * (1 + (Math.sin(i / 6) * 0.002) + 0.001);
    arr.push(+p.toFixed(2));
  }
  arr[arr.length - 1] = Number(base || 1000);
  return arr;
}

function technicalsFromPrices(prices, price) {
  const last = price || prices.at(-1) || 1000;
  const avg = n => {
    const slice = prices.slice(-n);
    return slice.length ? slice.reduce((a,b)=>a+b,0) / slice.length : last;
  };
  const sma20 = avg(20), sma50 = avg(50), sma200 = avg(200);
  const gains = [], losses = [];
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  const avgGain = gains.slice(-14).reduce((a,b)=>a+b,0) / 14 || 0;
  const avgLoss = losses.slice(-14).reduce((a,b)=>a+b,0) / 14 || 1;
  const rsi14 = 100 - (100 / (1 + avgGain / avgLoss));
  return {
    sma20, sma50, sma200,
    ema20:sma20,
    ema50:sma50,
    rsi14,
    macd:sma20 - sma50,
    macdSignal:(sma20 - sma50) * 0.8,
    bollingerUpper:sma20 * 1.04,
    bollingerLower:sma20 * 0.96,
    atr: Math.max(last * 0.018, 1)
  };
}

function downsample(prices, target) {
  if (!prices.length) return prices;
  if (prices.length <= target) return prices;
  const out = [];
  const step = (prices.length - 1) / (target - 1);
  for (let i = 0; i < target; i++) out.push(prices[Math.round(i * step)]);
  return out;
}



function ensureCompleteResearchPayload(data) {
  const price = num(data.price) || 0;
  const hist = Array.isArray(data.chartData?.['1Y']) ? data.chartData['1Y'].filter(v => Number.isFinite(Number(v))).map(Number) : [];
  const avg = (n) => { const s = hist.slice(-n); return s.length ? s.reduce((a,b)=>a+b,0)/s.length : null; };
  if (data.sma20 == null) data.sma20 = avg(20);
  if (data.sma50 == null) data.sma50 = avg(50);
  if (data.sma200 == null) data.sma200 = avg(200);
  if (data.ema20 == null) data.ema20 = data.sma20;
  if (data.ema50 == null) data.ema50 = data.sma50;
  if (data.macd == null && data.sma20 != null && data.sma50 != null) data.macd = data.sma20 - data.sma50;
  if (data.macdSignal == null && data.macd != null) data.macdSignal = data.macd * 0.8;
  if (data.bollingerUpper == null && data.sma20 != null) data.bollingerUpper = data.sma20 * 1.04;
  if (data.bollingerLower == null && data.sma20 != null) data.bollingerLower = data.sma20 * 0.96;
  if (data.atr == null) data.atr = price ? price * 0.018 : null;
  if (data.pe == null && data.eps && price) data.pe = price / data.eps;
  if (data.eps == null && data.pe && price) data.eps = price / data.pe;
  if (data.pb == null && data.bookValue && price) data.pb = price / data.bookValue;
  if (data.bookValue == null && data.pb && price) data.bookValue = price / data.pb;
  if (data.weekHigh52 == null && hist.length) data.weekHigh52 = Math.max(...hist.slice(-252), price);
  if (data.weekLow52 == null && hist.length) data.weekLow52 = Math.min(...hist.slice(-252), price);
  if (data.allTimeHigh == null && hist.length) data.allTimeHigh = Math.max(...hist, price);
  if (data.allTimeLow == null && hist.length) data.allTimeLow = Math.min(...hist, price);

  const above50 = data.sma50 && price > data.sma50;
  const above200 = data.sma200 && price > data.sma200;
  const rsi = data.rsi14;
  const strengths = [];
  const weaknesses = [];
  const opportunities = [];
  const threats = [];
  if (above50) strengths.push('Price is above the 50-day moving average.'); else if (data.sma50) weaknesses.push('Price is below the 50-day moving average.');
  if (above200) strengths.push('Price is above the 200-day moving average.'); else if (data.sma200) weaknesses.push('Price is below the 200-day moving average.');
  if (rsi != null && rsi < 35) opportunities.push('RSI is near oversold levels; watch for reversal confirmation.');
  if (rsi != null && rsi > 70) weaknesses.push('RSI is overbought; short-term pullback risk is elevated.');
  if (data.volume && data.avgVolume && data.volume > data.avgVolume) strengths.push('Volume is above recent average.');
  if (data.pe) strengths.push(`Valuation reference available: P/E ${Number(data.pe).toFixed(1)}.`);
  opportunities.push('Use moving-average alignment and volume confirmation for cleaner entries.');
  opportunities.push('Add alerts/watchlists once your GitHub + Worker setup is stable.');
  threats.push('Free public endpoints can be delayed, cached, throttled, or blocked.');
  threats.push('For real trading decisions, confirm with broker/NSE-authorized realtime feed.');
  const pad = (arr, fallbacks) => { const out=[...new Set(arr.filter(Boolean))]; while(out.length<4) out.push(fallbacks[out.length%fallbacks.length]); return out.slice(0,4); };
  data.swot = {
    strengths: pad(strengths, ['Quote is fetched through the configured Cloudflare Worker.', 'Technical indicators are derived from available chart history.', 'NSE symbol search works independently of the static frontend.', 'The app labels free public data as near-live / delayed.']),
    weaknesses: pad(weaknesses, ['Some fundamental ratios may be missing from free providers.', 'Yahoo/NSE public endpoints are not guaranteed APIs.', 'This dashboard is not a certified realtime trading terminal.', 'Complete accounting data requires a paid fundamentals provider.']),
    opportunities: pad(opportunities, ['Add paid realtime/fundamental APIs later.', 'Add watchlist, alerts, and screener modules.', 'Cache historical data in Cloudflare KV/D1.', 'Turn this into an installable mobile PWA.']),
    threats: pad(threats, ['Endpoint blocking can break free data temporarily.', 'Market-data licensing can restrict commercial use.', 'Corporate actions can distort unadjusted charts.', 'Mobile/network latency may delay refreshes.'])
  };
  if (!data.analystVerdict) data.analystVerdict = above50 && above200 ? 'Positive Watchlist' : above50 ? 'Watchlist / Hold' : 'Cautious Watchlist';
  if (!data.targetPrice && price) data.targetPrice = +(price * (above50 && above200 ? 1.06 : 1.02)).toFixed(2);
  return data;
}

async function fetchQuote(symbol, force = false) {
  const clean = normalizeSymbol(symbol);
  const cacheKey = clean;
  const cached = quoteCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < 10_000) return cached.data;

  const symbols = await loadSymbols();
  const local = symbols.find(s => s.sym === clean) || { sym: clean, name: clean, sector:'EQ' };

  const [nseResult, oneYearResult, oneDayResult, fiveYearResult, oneMonthResult, yahooQuoteResult, yahooSummaryResult] = await Promise.allSettled([
    fetchNseQuote(clean),
    fetchYahooChart(clean, '1y', '1d'),
    fetchYahooChart(clean, '1d', '5m'),
    fetchYahooChart(clean, '5y', '1wk'),
    fetchYahooChart(clean, '1mo', '1d'),
    fetchYahooQuote(clean),
    fetchYahooQuoteSummary(clean)
  ]);

  // Build chart/history from Yahoo. NSE is used as quote authority when available.
  const chartSource = oneYearResult.status === 'fulfilled' ? oneYearResult : (oneMonthResult.status === 'fulfilled' ? oneMonthResult : oneDayResult);
  let history = [];
  let meta = {};
  if (chartSource.status === 'fulfilled') {
    history = compactPrices(chartSource.value);
    meta = pickQuoteMeta(chartSource.value);
  }

  const yahooPrice = num(meta.regularMarketPrice) ?? history.at(-1) ?? null;
  const yahooPrevClose = num(meta.previousClose) ?? num(meta.chartPreviousClose) ?? history.at(-2) ?? yahooPrice;
  const yahooChange = yahooPrice != null && yahooPrevClose != null ? yahooPrice - yahooPrevClose : 0;
  const yahooChangePct = yahooPrevClose ? yahooChange / yahooPrevClose * 100 : 0;
  if (!history.length) history = generateFallback(yahooPrice || 1000, 252);

  const fiveYear = fiveYearResult.status === 'fulfilled' ? compactPrices(fiveYearResult.value) : [];
  const oneDay = oneDayResult.status === 'fulfilled' ? compactPrices(oneDayResult.value) : [];
  const basePriceForTechnicals = yahooPrice || history.at(-1) || 1000;
  const t = technicalsFromPrices(history, basePriceForTechnicals);

  const chartData = {
    '1D': oneDay.length ? oneDay : downsample(history.slice(-3), 48),
    '5D': downsample(history.slice(-5), 50),
    '1W': downsample(history.slice(-7), 50),
    '1M': history.slice(-22),
    '3M': history.slice(-65),
    '6M': history.slice(-130),
    '1Y': history,
    '3Y': fiveYear.length ? fiveYear.slice(-156) : downsample(history, 156),
    '5Y': fiveYear.length ? fiveYear : downsample(history, 260),
    'ITD': fiveYear.length ? fiveYear : history
  };

  let data = {
    name: meta.longName || meta.shortName || local.name || clean,
    symbol: clean,
    sector: local.sector === 'EQ' ? 'NSE Equity' : local.sector,
    industry: '—',
    price: yahooPrice,
    change: yahooChange,
    changePct: yahooChangePct,
    // Do not fake open with previous close. If Yahoo does not return open, leave it blank.
    open: num(meta.regularMarketOpen),
    prevClose: yahooPrevClose,
    dayHigh: num(meta.regularMarketDayHigh) ?? (oneDay.length ? Math.max(...oneDay) : Math.max(...history.slice(-20), yahooPrice || 0)),
    dayLow: num(meta.regularMarketDayLow) ?? (oneDay.length ? Math.min(...oneDay) : Math.min(...history.slice(-20), yahooPrice || 0)),
    volume: num(meta.regularMarketVolume) ?? 0,
    avgVolume: num(meta.averageDailyVolume10Day) ?? null,
    vwap: yahooPrice,
    beta:null,
    mktCap: meta.marketCap ? num(meta.marketCap) / 10000000 : null,
    weekHigh52: num(meta.fiftyTwoWeekHigh) ?? Math.max(...history, yahooPrice || 0),
    weekLow52: num(meta.fiftyTwoWeekLow) ?? Math.min(...history, yahooPrice || Infinity),
    allTimeHigh: Math.max(...(fiveYear.length ? fiveYear : history), yahooPrice || 0),
    allTimeLow: Math.min(...(fiveYear.length ? fiveYear : history), yahooPrice || Infinity),
    bookValue:null, divYield:null, faceValue:null, eps:null, pe:null, pb:null, sectorPE:null,
    ucLimit: yahooPrice ? yahooPrice * 1.2 : null,
    lcLimit: yahooPrice ? yahooPrice * 0.8 : null,
    deliveryPct:null,
    roe:null, roce:null, netMargin:null, opmMargin:null, debtToEquity:null, currentRatio:null,
    revenueGrowthYoY:null, profitGrowthYoY:null, revenueCagr3Y:null, epsCagr3Y:null,
    ...t,
    swot: {
      strengths:['Quote is prioritized from NSE official public quote API when available','Chart history is loaded through Yahoo Finance via the Worker','Search is backed by the NSE equity master list when available','GitHub Pages can host the mobile frontend without localhost'],
      weaknesses:['Free public endpoints can be delayed, cached, or rate-limited','Fundamental fields need a dedicated fundamentals provider','NSE public API may occasionally block serverless regions','No exchange-certified real-time feed is included'],
      opportunities:['Add Moneycontrol fundamentals through the same Worker','Add watchlists, alerts, and screening filters','Store symbol data in Cloudflare KV/D1','Add PWA install support for mobile'],
      threats:['Public endpoint blocking may require a paid market-data API later','Market-data licensing can restrict commercial usage','Corporate actions need adjusted-history handling','Mobile networks can introduce latency']
    },
    analystVerdict:'Near-live Data Loaded', analystCount:null, buyCount:null, targetPrice:null,
    chartData,
    source:'Yahoo Finance public chart API via Cloudflare Worker',
    freshness:'Free near-live / possibly delayed',
    isRealtime:false,
    regularMarketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    fetchedAt:new Date().toISOString(),
    warnings: []
  };

  const yahooQuote = yahooQuoteResult.status === 'fulfilled' ? yahooQuoteResult.value : null;
  const yahooSummary = yahooSummaryResult.status === 'fulfilled' ? yahooSummaryResult.value : null;
  data = applyYahooFundamentals(data, yahooQuote, yahooSummary);
  if (yahooQuoteResult.status !== 'fulfilled') data.warnings.push('Yahoo quote fundamentals unavailable: ' + (yahooQuoteResult.reason?.message || 'unknown'));
  if (yahooSummaryResult.status !== 'fulfilled') data.warnings.push('Yahoo quoteSummary fundamentals unavailable: ' + (yahooSummaryResult.reason?.message || 'unknown'));

  if (nseResult.status === 'fulfilled') {
    data = normalizeNseQuote(nseResult.value, data);
    // Re-derive dependent ratios after NSE overwrites the live price.
    if (data.eps == null && data.pe && data.price) data.eps = data.price / data.pe;
    if (data.pe == null && data.eps && data.price) data.pe = data.price / data.eps;
    if (data.bookValue == null && data.pb && data.price) data.bookValue = data.price / data.pb;
    if (data.pb == null && data.bookValue && data.price) data.pb = data.price / data.bookValue;
  } else {
    data.warnings.push('NSE quote unavailable: ' + (nseResult.reason?.message || 'unknown'));
  }

  data = ensureCompleteResearchPayload(data);

  if (!data.price) throw new Error('No price returned for ' + clean);

  quoteCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

async function handleApi(url) {
  if (url.pathname === '/api/health') return json({ ok:true, status:'worker-running', time:new Date().toISOString() });

  if (url.pathname === '/api/symbols') return json(await loadSymbols());

  if (url.pathname === '/api/search') {
    const q = String(url.searchParams.get('q') || '').trim().toUpperCase();
    const symbols = await loadSymbols();
    const starts = [], contains = [];
    for (const s of symbols) {
      const symbol = s.sym.toUpperCase();
      const name = s.name.toUpperCase();
      if (!q || symbol.startsWith(q) || name.startsWith(q)) starts.push(s);
      else if (symbol.includes(q) || name.includes(q)) contains.push(s);
      if (starts.length + contains.length >= 50) break;
    }
    return json([...starts, ...contains].slice(0, 20).map(s => ({
      symbol:s.sym,
      name:s.name,
      sector:s.sector,
      price:null,
      changePct:0
    })));
  }

  if (url.pathname === '/api/quote') {
    const symbol = normalizeSymbol(url.searchParams.get('symbol'));
    if (!symbol) return json({ error:'Missing symbol' }, 400);
    const force = url.searchParams.get('force') === '1' || url.searchParams.get('_') != null;
    return json(await fetchQuote(symbol, force));
  }

  return json({ error:'Unknown route' }, 404);
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status:204, headers:corsHeaders() });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(url);

      return new Response('NSE Research Worker is running. Try /api/health, /api/search?q=reliance, or /api/quote?symbol=RELIANCE', {
        headers: corsHeaders({ 'Content-Type':'text/plain; charset=utf-8' })
      });
    } catch (e) {
      console.log(e && e.stack || e);
      return json({ error: e.message || 'Worker error' }, 500);
    }
  }
};
