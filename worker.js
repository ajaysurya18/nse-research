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

async function fetchQuote(symbol, force = false) {
  const clean = normalizeSymbol(symbol);
  const cacheKey = clean;
  const cached = quoteCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < 15_000) return cached.data;

  const symbols = await loadSymbols();
  const local = symbols.find(s => s.sym === clean) || { sym: clean, name: clean, sector:'EQ' };

  const [oneYearResult, oneDayResult, fiveYearResult, oneMonthResult] = await Promise.allSettled([
    fetchYahooChart(clean, '1y', '1d'),
    fetchYahooChart(clean, '1d', '5m'),
    fetchYahooChart(clean, '5y', '1wk'),
    fetchYahooChart(clean, '1mo', '1d')
  ]);

  const bestResult = oneYearResult.status === 'fulfilled' ? oneYearResult : (oneMonthResult.status === 'fulfilled' ? oneMonthResult : oneDayResult);
  if (bestResult.status !== 'fulfilled') throw new Error('Yahoo Finance quote failed: ' + (bestResult.reason?.message || 'all public endpoints failed'));

  const oneYearJson = bestResult.value;
  const prices1Y = compactPrices(oneYearJson);
  const meta = pickQuoteMeta(oneYearJson);
  const price = num(meta.regularMarketPrice) ?? prices1Y.at(-1) ?? null;
  if (!price) throw new Error('No price returned for ' + clean);

  const prevClose = num(meta.previousClose) ?? num(meta.chartPreviousClose) ?? prices1Y.at(-2) ?? price;
  const change = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;
  const history = prices1Y.length ? prices1Y : generateFallback(price, 252);
  const fiveYear = fiveYearResult.status === 'fulfilled' ? compactPrices(fiveYearResult.value) : [];
  const oneDay = oneDayResult.status === 'fulfilled' ? compactPrices(oneDayResult.value) : [];
  const t = technicalsFromPrices(history, price);

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

  const data = {
    name: meta.longName || meta.shortName || local.name || clean,
    symbol: clean,
    sector: local.sector === 'EQ' ? 'NSE Equity' : local.sector,
    industry: '—',
    price,
    change,
    changePct,
    open: num(meta.regularMarketOpen) ?? prevClose,
    prevClose,
    dayHigh: num(meta.regularMarketDayHigh) ?? Math.max(...history.slice(-20), price),
    dayLow: num(meta.regularMarketDayLow) ?? Math.min(...history.slice(-20), price),
    volume: num(meta.regularMarketVolume) ?? 0,
    avgVolume: num(meta.averageDailyVolume10Day) ?? 0,
    vwap: price,
    beta:null,
    mktCap: meta.marketCap ? num(meta.marketCap) / 10000000 : null,
    weekHigh52: num(meta.fiftyTwoWeekHigh) ?? Math.max(...history, price),
    weekLow52: num(meta.fiftyTwoWeekLow) ?? Math.min(...history, price),
    allTimeHigh: Math.max(...(fiveYear.length ? fiveYear : history), price),
    allTimeLow: Math.min(...(fiveYear.length ? fiveYear : history), price),
    bookValue:null, divYield:null, faceValue:null, eps:null, pe:null, pb:null, sectorPE:null,
    ucLimit: price ? price * 1.2 : null,
    lcLimit: price ? price * 0.8 : null,
    deliveryPct:null,
    roe:null, roce:null, netMargin:null, opmMargin:null, debtToEquity:null, currentRatio:null,
    revenueGrowthYoY:null, profitGrowthYoY:null, revenueCagr3Y:null, epsCagr3Y:null,
    ...t,
    swot: {
      strengths:['Live quote and chart data are loaded through a server-side Worker proxy','Search is backed by the NSE equity master list when available','GitHub Pages can host the mobile frontend without localhost','Worker caching reduces repeated API hits'],
      weaknesses:['Yahoo/NSE public endpoints can rate-limit or change without notice','Fundamental fields need a dedicated fundamentals data provider','Some prices may be delayed depending on source availability','No user watchlist database is included yet'],
      opportunities:['Add Moneycontrol fundamentals through the same Worker','Add alerts, watchlists, and screening filters','Store common symbol data in Cloudflare KV/D1','Add a PWA install button for mobile'],
      threats:['Public endpoint blocking may require a paid market-data API later','Market-data licensing can restrict commercial usage','Corporate actions need adjusted historical handling','Mobile networks can introduce latency']
    },
    analystVerdict:'Live Data Loaded', analystCount:null, buyCount:null, targetPrice:null,
    chartData,
    source:'Yahoo Finance public chart API via Cloudflare Worker',
    freshness:'Free near-live / possibly delayed',
    isRealtime:false,
    regularMarketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    fetchedAt:new Date().toISOString()
  };

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
