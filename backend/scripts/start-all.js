/* Starts paper simulations on every pair, for one account, through the app's own API, so they show
 * in the dashboard exactly as if they had been started by hand. Safe to run again: anything already
 * running (same exchange, pair and direction) is skipped, so there are never duplicates.
 *
 *   docker compose exec backend node scripts/start-all.js abdut@gmail.com 'the-password'
 *
 * Options (all optional):
 *   --usd 1000                 USDT worth of each order (15 orders per simulation)
 *   --orders 15                orders per ladder
 *   --rates 3,1,1,1            first order %, step %, buyback %, re-sell %
 *   --venues BYBIT,MEXC        exchanges to use
 *   --directions SELL_FIRST,BUY_FIRST
 *   --pairs ZIGUSDT,BTCUSDT    only these pairs (default: every pair the exchange lists)
 *   --api http://127.0.0.1:3069/api
 *   --dry-run                  print what would start, start nothing
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
// The two plain arguments are the email and password; every --option except --dry-run takes a value.
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') continue;
  if (args[i].startsWith('--')) { i++; continue; }
  positional.push(args[i]);
}
const [email, password] = positional;
if (!email || !password) {
  console.error("usage: node scripts/start-all.js <email> '<password>' [--usd 1000] [--rates 3,1,1,1] [--venues BYBIT,MEXC] [--dry-run]");
  process.exit(1);
}

const API = opt('api', process.env.START_ALL_API || `http://127.0.0.1:${process.env.PORT || 3069}/api`);
const USD = Number(opt('usd', '1000'));
const ORDERS = Number(opt('orders', '15'));
const [FIRST, STEP, BUYBACK, RESELL] = opt('rates', '3,1,1,1').split(',');
const VENUES = opt('venues', 'BYBIT,MEXC').split(',');
const DIRECTIONS = opt('directions', 'SELL_FIRST,BUY_FIRST').split(',');
const ONLY = opt('pairs', '') ? opt('pairs', '').split(',') : null;
const DRY = args.includes('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'zig', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const fmtUsd = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

async function main() {
  const login = await call('POST', '/auth/login', { email, password });
  if (login.status >= 300) throw new Error(`login failed (${login.status}): ${JSON.stringify(login.data)}`);
  console.log(`logged in as ${email}`);

  const { data: o } = await call('GET', '/series');
  const running = new Set(o.runs.filter((r) => r.status !== 'STOPPED').map((r) => `${r.venue}:${r.symbol}:${r.direction}`));

  const plan = [];
  for (const venue of VENUES) {
    const v = o.venues.find((x) => x.venue === venue);
    if (!v) { console.log(`skip ${venue}: not offered`); continue; }
    for (const { symbol } of v.pairs) {
      if (ONLY && !ONLY.includes(symbol)) continue;
      const price = Number(o.markets[`${venue}:${symbol}`]);
      for (const direction of DIRECTIONS) {
        const key = `${venue}:${symbol}:${direction}`;
        if (running.has(key)) { console.log(`already running: ${key}`); continue; }
        if (!(price > 0)) { console.log(`skip ${key}: no market price right now`); continue; }
        const sellFirst = direction === 'SELL_FIRST';
        plan.push({
          key,
          settings: {
            symbol, venue, direction, dailyReset: true, basePrice: null, sellPct: '100', orders: ORDERS,
            firstSellPct: FIRST, stepPct: STEP, buybackPct: BUYBACK, resellPct: RESELL, maxCycles: null, maxHours: null,
            // About USD per order: sell first holds the coin worth orders x USD; buy first holds that much USDT.
            totalZig: sellFirst ? ((ORDERS * USD) / price).toFixed(6) : '0',
            startUsdt: sellFirst ? '0' : String(ORDERS * USD),
          },
        });
      }
    }
  }
  console.log(`${plan.length} to start, about ${fmtUsd(USD)} per order, ${fmtUsd(ORDERS * USD)} each, rates ${FIRST}% / ${STEP}% / ${BUYBACK}% / ${RESELL}%${DRY ? ' (dry run)' : ''}`);

  let ok = 0;
  const failed = [];
  for (const p of plan) {
    if (DRY) { console.log(`would start ${p.key}: ${p.settings.direction === 'SELL_FIRST' ? `${p.settings.totalZig} coin` : `${p.settings.startUsdt} USDT`}`); continue; }
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await call('POST', '/series/start', { settings: p.settings });
      if (r.status === 429) { console.log(`  rate limited, waiting 60 s…`); await sleep(60_000); continue; }
      if (r.status < 300) { ok++; console.log(`started ${p.key}`); }
      else { failed.push(p.key); console.log(`FAILED ${p.key} (${r.status}): ${typeof r.data === 'object' ? JSON.stringify(r.data.message ?? r.data) : r.data}`); }
      break;
    }
    // The start endpoint allows 10 a minute per user: stay under it.
    await sleep(6500);
  }
  if (!DRY) console.log(`done: ${ok} started, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}. Open the dashboard to see them.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
