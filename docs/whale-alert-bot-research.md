# ZIG Whale-Alert Telegram Bot — Research & Build Spec

Goal: a Telegram bot that posts "unusual buying/selling activity" alerts for **ZIG/USDT**
across all 5 integrated exchanges, in the style of the *Whale Sniper* alert:

```
<Exchange> - USDT Market
#ZIG - Unusual buying activity
9.45M USDT in 5 minutes (11%)
P: 0.0463 (1.70%)
24H Vol: 95.2M USDT
Last alert: 2 days ago
```

---

## 1. Feasibility verdict — ✅ Yes, and most of it already exists

Two things are already built in this repo and can be reused directly:

1. **Normalized trade streams for all 5 exchanges.** Every gateway already decodes each
   exchange's WS trade feed and emits a uniform shape:
   `{ price:number, qty:number, time:number, side:'BUY'|'SELL' }`.
   (See the `handleXMessage` → `emit('trades', …)` in each `*.gateway.ts`.)
2. **A Telegram sender.** `AlertService.send(html)` already posts HTML messages to
   `TELEGRAM_ADMIN_ID` via `TELEGRAM_BOT_TOKEN`. The whale bot just calls it.

So the new work is a **detector**: aggregate trades in a rolling window, compare against
a baseline, format the message, apply a cooldown, and call `AlertService.send`.

---

## 2. What each alert field needs (data → source)

| Alert field | Meaning | Data source |
|---|---|---|
| `Unusual buying/selling` | which side dominated the window | trade stream `side` |
| `9.45M USDT in 5 minutes` | Σ(price×qty) of taker-`BUY` (or `SELL`) trades in a 5-min window | trade stream |
| `(11%)` | window USDT ÷ 24h USDT volume | 24h ticker `quoteVolume` |
| `P: 0.0463` | last price | trade stream / ticker |
| `(1.70%)` | 24h price change % | 24h ticker |
| `24H Vol: 95.2M USDT` | rolling 24h quote volume | 24h ticker |
| `Last alert: 2 days ago` | cooldown/state | bot's own state store |

**Core signal:** the aggressor (taker) side of each public trade. Summing taker-BUY
notional over a short window and comparing it to the 24h baseline is exactly what produces
the "N USDT in 5 minutes (X%)" line.

---

## 3. Architecture — two options

### Option A — piggyback on existing WS gateways (recommended)
The gateways already stream normalized trades. Add a `WhaleWatchService` that subscribes to
the same trade events (either by consuming the internal gateway or by connecting a Socket.IO
client to each `/mexc`, `/bybit`, … namespace). Aggregate per exchange in memory.

- ✅ Real-time (sub-second), no polling, no extra rate-limit pressure.
- ✅ Reuses proven decoders (incl. the new MEXC protobuf).
- ⚠️ Needs the backend running; trades only flow while a client is connected (the gateways
  connect to the exchange on first client). For an always-on bot, make the whale service
  itself a permanent client so streams stay alive.

### Option B — standalone REST poller
A separate process polls each exchange's *recent trades* + *24h ticker* every 5–15s.

- ✅ Fully independent of the terminal; simplest to reason about.
- ⚠️ Recent-trades endpoints return only the last N trades — at high trade rates you can miss
  trades between polls (undercount). Fine for a low-liquidity coin like ZIG, risky if volume spikes.
- ⚠️ More REST calls → watch rate limits.

**Recommendation:** Option A for accuracy (it sees every trade), with the 24h ticker fetched
via a light REST poll every ~30s per exchange for the `%` and `24H Vol` context lines.

---

## 4. Per-exchange API reference (all grounded in this repo's adapters)

Symbol formats differ per exchange — already defined as `SYMBOL` in each service.

| Exchange | Symbol | REST base | WS base |
|---|---|---|---|
| MEXC | `ZIGUSDT` | `https://api.mexc.com` | `wss://wbs-api.mexc.com/ws` |
| Bybit | `ZIGUSDT` | `https://api.bybit.com` | `wss://stream.bybit.com/v5/public/spot` |
| KuCoin | `ZIG-USDT` | `https://api.kucoin.com` | (token-based, see below) |
| Gate.io | `ZIG_USDT` | `https://api.gateio.ws` | `wss://api.gateio.ws/ws/v4/` |
| Bitget | `ZIGUSDT` | `https://api.bitget.com` | `wss://ws.bitget.com/v2/ws/public` |

### 4.1 MEXC
- **24h ticker:** `GET /api/v3/ticker/24hr?symbol=ZIGUSDT` → `lastPrice, priceChangePercent, quoteVolume`
- **Recent trades:** `GET /api/v3/trades?symbol=ZIGUSDT&limit=1000` → `price, qty, quoteQty, time, isBuyerMaker`
  - ⚠️ side nuance: `isBuyerMaker=true` ⇒ taker was the **seller** ⇒ count as **SELL**.
- **Klines (baseline):** `GET /api/v3/klines?symbol=ZIGUSDT&interval=5m&limit=288`
- **WS trades (in repo):** `spot@public.aggre.deals.v3.api.pb@100ms@ZIGUSDT` (protobuf; `tradeType` 1=BUY 2=SELL)

### 4.2 Bybit
- **24h ticker:** `GET /v5/market/tickers?category=spot&symbol=ZIGUSDT` → `lastPrice, price24hPcnt, turnover24h`(quote), `volume24h`(base)
- **Recent trades:** `GET /v5/market/recent-trade?category=spot&symbol=ZIGUSDT&limit=1000` → `price, size, side(Buy/Sell), time`
- **Klines:** `GET /v5/market/kline?category=spot&symbol=ZIGUSDT&interval=5&limit=288`
- **WS trades (in repo):** `publicTrade.ZIGUSDT` (`S` = Buy/Sell taker side)

### 4.3 KuCoin
- **24h ticker:** `GET /api/v1/market/stats?symbol=ZIG-USDT` → `last, changeRate, volValue`(quote), `vol`(base)
- **Recent trades:** `GET /api/v1/market/histories?symbol=ZIG-USDT` → `price, size, side(buy/sell), time` (last ~100)
- **Klines:** `GET /api/v1/market/candles?symbol=ZIG-USDT&type=5min`
- **WS trades (in repo):** `/market/match:ZIG-USDT` (`side` buy/sell)
  - WS requires a token: `POST /api/v1/bullet-public` → connect to returned endpoint (already handled in the KuCoin gateway).

### 4.4 Gate.io
- **24h ticker:** `GET /api/v4/spot/tickers?currency_pair=ZIG_USDT` → `last, change_percentage, quote_volume, base_volume`
- **Recent trades:** `GET /api/v4/spot/trades?currency_pair=ZIG_USDT&limit=1000` → `price, amount, side(buy/sell), create_time_ms`
- **Klines:** `GET /api/v4/spot/candlesticks?currency_pair=ZIG_USDT&interval=5m&limit=288`
- **WS trades (in repo):** channel `spot.trades`, payload `side` buy/sell

### 4.5 Bitget
- **24h ticker:** `GET /api/v2/spot/market/tickers?symbol=ZIGUSDT` → `lastPr, change24h, quoteVolume, baseVolume`
- **Recent trades:** `GET /api/v2/spot/market/fills?symbol=ZIGUSDT&limit=500` → `price, size, side(buy/sell), ts`
- **Klines:** `GET /api/v2/spot/market/candles?symbol=ZIGUSDT&granularity=5min&limit=200`
- **WS trades (in repo):** `{ instType:'SPOT', channel:'trade', instId:'ZIGUSDT' }` (`side` buy/sell)

> ⚠️ **Verify listing first:** confirm ZIG/USDT is actually live on each of the 5 (the terminal
> assumes it). If an exchange doesn't list ZIG, its ticker/trades calls will 400 — skip it.

---

## 5. Detection algorithm

Per exchange, per side (BUY/SELL):

1. **Rolling window buffer** of trades from the last `WINDOW` minutes (default 5), each stored
   as `{ notionalUsdt = price×qty, side, ts }`. Evict entries older than `WINDOW`.
2. **Baseline (self-normalizing).** Track 24h quote volume from the ticker. Average per-window
   volume = `vol24h × (WINDOW / 1440)`. (For 5-min windows that's `vol24h/288`.)
3. **Trigger** an alert for a side when **either**:
   - `windowNotional ≥ ABS_THRESHOLD_USDT` (absolute floor, e.g. configurable per exchange), **and/or**
   - `windowNotional / vol24h ≥ SHARE_PCT` (e.g. ≥ 8–12% of 24h vol in one window — matches the "(11%)" line), **or**
   - `windowNotional ≥ K × avgWindowVol` (relative spike, e.g. K=6–10× the typical window).
4. **Cooldown / dedupe.** After firing for (exchange, side), suppress further alerts for that pair
   for `COOLDOWN` (e.g. 30–60 min). Store `lastAlertAt` → renders the "Last alert: 2 days ago" line.
5. **Format & send** via `AlertService.send(html)`.

Recommended defaults (tune to ZIG's liquidity): `WINDOW=5min`, `SHARE_PCT=10%`,
`K=8×`, `ABS_THRESHOLD` per-exchange, `COOLDOWN=45min`.

### Message template (HTML for Telegram)
```
🐋 <b>Whale Sniper</b>
<b>{EXCHANGE}</b> — USDT Market
#ZIG — Unusual <b>{buying|selling}</b> activity
{windowUsdt} USDT in {WINDOW} minutes ({sharePct}%)
P: {price} ({priceChangePct}%)
24H Vol: {vol24h} USDT
Last alert: {humanizedSinceLast}
```

---

## 6. Telegram delivery
Reuse the existing `AlertService` (`backend/src/alert/alert.service.ts`):
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ADMIN_ID` in `.env` (already wired).
- For multiple subscribers or a channel, extend `send()` to accept a chat id, or post to a
  channel id instead of the admin id.

---

## 7. Open questions to decide before building
1. **Thresholds:** absolute USDT floor per exchange? Preferred `SHARE_PCT` and `K`?
2. **Sides:** alert on both buying and selling, or buys only?
3. **Window:** 5 min like the sample, or also a faster 1-min tier?
4. **Delivery:** your admin DM (current), or a public/private Telegram channel?
5. **Aggregate vs per-exchange:** one alert per exchange (like the sample), or also a combined
   "cross-exchange" surge alert?
