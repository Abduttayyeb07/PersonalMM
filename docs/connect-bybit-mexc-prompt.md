# Prompt: Securely connect Bybit + MEXC (simple frontend, protobuf WS)

> Paste everything below the line into your coding AI (Claude Code, etc.) from the repo root.

---

## ROLE
You are a senior full-stack + security engineer working in the ZIG MM repo (NestJS backend in `backend/`, Next.js frontend in `frontend/`, Postgres via Prisma, Docker Compose). Implement a **minimal, secure "Connect exchange" flow for ONLY Bybit and MEXC**, using the **latest MEXC protobuf WebSocket API** for MEXC market/user data.

Read before changing anything: `backend/src/credentials/*`, `backend/src/encryption/*`, `backend/src/auth/*`, `backend/src/mexc/*`, `backend/src/bybit/*`, `frontend/components/ConnectExchange.tsx`, `frontend/lib/api.ts`, `docker-compose.yml`. Reuse what exists; do not rewrite working code.

## SCOPE
- Exchanges: **`mexc` and `bybit` only**. Remove kucoin / gateio / bitget from the connect UI and from the `@IsIn([...])` list in `save-credentials.dto.ts`. (Leave their backend modules alone unless trivially removable; do not break the build.)
- Frontend: one simple page/modal with two cards (Bybit, MEXC). Each card shows status (Connected / Not connected), a "Connect" form (API key, API secret), "Test connection", and "Disconnect". No passphrase field (neither exchange uses one).
- Backend: keep the existing `POST/GET/DELETE /api/credentials` model and extend it as below.

## THREAT MODEL (what "not compromised" means here)
1. A user's API key/secret must never be readable by other users, the frontend after submission, logs, error messages, analytics, or git.
2. A stolen DB dump must be useless without the encryption key.
3. A stolen/hijacked session must not be able to extract stored keys (keys are write-only from the client's view).
4. Even if the server is fully compromised, the exchange keys should be unable to withdraw funds.
5. XSS/CSRF must not be able to exfiltrate or abuse credentials.

## SECURITY REQUIREMENTS (all mandatory)

### A. Key handling in the browser
- Inputs: `type="password"`, `autocomplete="off"`, `autoCapitalize="off"`, `spellCheck={false}`. Hold values in React state only; **never** in localStorage/sessionStorage/URL/cookies/Zustand persisted store/console.
- On submit: send over HTTPS via the existing axios client (`withCredentials: true`), then **immediately clear the state** (success *and* failure) and unmount the form values.
- No third-party scripts on the connect page. Add a strict CSP (see D). No analytics/session-replay on this page.
- Show the user, before they paste keys: "Create a **trade-only** key. **Disable withdrawals.** Whitelist this server's IP."

### B. Transport and session
- HTTPS only. Set `COOKIE_SECURE=true` in production (currently defaults off; add it to `docker-compose.yml` and `.env.example`, and fail startup if `NODE_ENV=production` and it is not `true`).
- Auth cookie stays `httpOnly`, `sameSite`: change `lax` -> `strict` if the app is single-origin (it is, via the reverse proxy).
- **Re-authentication for sensitive actions:** `POST /credentials` and `DELETE /credentials/:exchange` must require the user's password again in the request body (verify with the existing bcrypt/argon check in `auth.service.ts`). Rate-limit these to 5/min/user with `@Throttle`.
- CSRF: with `sameSite=strict` plus a custom header requirement (e.g. `X-Requested-With: zig`) checked by a guard on all state-changing routes.

### C. Server-side storage
- Keep AES-256-GCM (`EncryptionService`). Upgrades:
  - Prefix ciphertext with a **key version** (`v1:` + base64) so `ENCRYPTION_KEY` can be rotated; support `ENCRYPTION_KEY` (current) and `ENCRYPTION_KEY_PREV` (decrypt-only). Add a `scripts/rotate-encryption-key.ts` that re-encrypts all rows.
  - Bind ciphertext to its owner with **AAD** = `${userId}:${exchange}` (`cipher.setAAD`). A row copied to another user/exchange must fail to decrypt.
- Validate secrets at startup (`ConfigModule` validation / zod / Joi): `ENCRYPTION_KEY` 64 hex, `JWT_SECRET` >= 32 chars and not the placeholder, `DATABASE_URL` present. In production also reject the default `zigpass` Postgres password. Remove the `:-zigpass` fallback in `docker-compose.yml`.
- DTO: `apiKey` and `apiSecret` -> `@IsString() @IsNotEmpty() @MaxLength(256) @Matches(/^\S+$/)`. `exchange` -> `@IsIn(['mexc','bybit'])`.
- **Write-only API:** no endpoint may ever return key/secret (even masked beyond the last 4 chars of the key; return `keyHint: "…a1b2"` computed at save time and stored in a new nullable column, not by decrypting on read).
- Decrypt only inside the service call that signs a request; never cache plaintext on a long-lived object; never pass it through logs, exceptions, or Telegram alerts. Add a Nest `LoggerService`/filter scrub that redacts `apiKey`, `apiSecret`, `X-BAPI-*`, `X-MEXC-APIKEY`, `signature`, `Authorization`, cookies. Update `AllExceptionsFilter` so it never forwards request bodies of `/credentials` to `AlertService`.
- Postgres: dedicated least-privilege DB user, not exposed publicly (already internal to compose; keep it that way — no `ports:` for postgres).

### D. Browser hardening
- Add Helmet to `main.ts` and Next.js security headers in `next.config.ts`:
  `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' wss://<your-domain>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  plus `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (disable camera/mic/geo).
- Never `dangerouslySetInnerHTML` anything exchange- or user-supplied.

### E. Exchange-side permission verification ("test connection")
On save, the backend must **verify the key before persisting** and refuse unsafe keys:
- **Bybit:** `GET /v5/user/query-api` (signed). Reject if `permissions.Wallet` contains `Withdraw`, or if `readOnly` is true (we need trade), or if the key is not IP-bound (`ips` empty / `*`) when `REQUIRE_IP_WHITELIST=true`. Show a clear message for each failure.
- **MEXC:** `GET /api/v3/account` (signed, `recvWindow`) to confirm validity and `canTrade`. MEXC's API cannot reliably report withdraw permission, so show a **mandatory confirmation checkbox**: "I confirmed withdrawals are disabled and IP whitelisting is on." Block Save until ticked.
- Do not persist if validation fails. Return generic errors (`"Invalid or unsafe API key"`) — never echo exchange responses containing key material.

### F. Auditing
- New table `CredentialAudit` (userId, exchange, action: SAVE|TEST|DELETE, ip, userAgent, createdAt) — never any key material. Write on every credentials action. Optionally send a Telegram alert on SAVE/DELETE ("Bybit key connected for <user>") without key data.

## FUNCTIONAL REQUIREMENTS

### Bybit (V5, REST + WebSocket JSON)
- Bybit has **no protobuf API** — its V5 WebSocket is JSON. Use REST `https://api.bybit.com` with headers `X-BAPI-API-KEY`, `X-BAPI-SIGN`, `X-BAPI-TIMESTAMP`, `X-BAPI-RECV-WINDOW`; signature = HMAC-SHA256(secret, `timestamp + apiKey + recvWindow + (queryString | jsonBody)`), hex. Market data: public WS `wss://stream.bybit.com/v5/public/spot` (`orderbook.50.<SYMBOL>`, `publicTrade.<SYMBOL>`, `tickers.<SYMBOL>`) with a 20s `{"op":"ping"}` heartbeat and auto-reconnect w/ backoff. Private order/wallet updates: `wss://stream.bybit.com/v5/private` with `auth` op (expires + HMAC) then subscribe to `order`, `wallet`. The existing `bybit.service.ts` already covers REST — keep it and add only what's missing.

### MEXC (Spot V3, REST + **protobuf** WebSocket)
- REST `https://api.mexc.com` with header `X-MEXC-APIKEY`; signature = HMAC-SHA256(secret, queryString incl. `timestamp` + `recvWindow`) hex, appended as `&signature=`.
- WebSocket (protobuf, latest): `wss://wbs-api.mexc.com/ws`. Subscribe with JSON text frames, receive **binary protobuf** frames:
  - `{"method":"SUBSCRIPTION","params":["spot@public.aggre.depth.v3.api.pb@100ms@BTCUSDT"]}` (also `spot@public.aggre.deals.v3.api.pb@100ms@<SYMBOL>`, `spot@public.aggre.bookTicker.v3.api.pb@100ms@<SYMBOL>`, `spot@public.limit.depth.v3.api.pb@<SYMBOL>@5`, `spot@public.miniTicker.v3.api.pb@<SYMBOL>@UTC+8`).
  - Private streams: create a listenKey via `POST /api/v3/userDataStream` (signed), connect/subscribe with `spot@private.orders.v3.api.pb`, `spot@private.deals.v3.api.pb`, `spot@private.account.v3.api.pb`; **keep alive** with `PUT /api/v3/userDataStream` every ~30 min, `DELETE` on disconnect/credential removal. The listenKey is a secret — never log it or send it to the browser.
  - Decode every frame with `protobufjs` against the `.proto` files already in `backend/src/mexc/proto/` (wrapper: `PushDataV3ApiWrapper`; switch on `channel`). Verify the protos match MEXC's latest at https://github.com/mexcdevelop/websocket-proto and update if not.
  - Send `{"method":"PING"}` every 30s; reconnect with exponential backoff + jitter; resubscribe after reconnect; max 30 subscriptions per connection; reconnect before the 24h connection limit.
  - Non-binary frames (e.g. `{"id":0,"code":0,"msg":"..."}`) are control messages — parse as JSON, handle errors, never feed them to protobuf.
- Relay decoded data to the browser through the existing Socket.IO gateway as **plain JSON**, authenticated with the same JWT cookie; the browser never talks to MEXC/Bybit directly and never sees a key or listenKey.

## TRADING REQUIREMENTS: BUY / SELL ZIG (spot, ZIG/USDT)
Goal: once connected, the user can buy and sell **ZIG against USDT** on Bybit and MEXC, per exchange or on both at once. The pair is `ZIGUSDT` on both (internal `ZIG/USDT`, see `exchange/symbol.util.ts`). Spot only: no margin, futures, or leverage. The symbol is hardcoded server-side; the client must never be able to pass a different symbol.

Existing pieces to reuse (verify they work, fix gaps, don't rewrite): `POST /api/mexc/orders`, `POST /api/bybit/orders`, `POST /api/all/orders` (`all-exchanges.service.ts`, parallel dispatch to both), `PlaceOrderDto`, `precision.engine.ts`, `client-oid.util.ts`, `order-state.util.ts`, `execution-log`, and `frontend/components/TradingPanel.tsx`.

### Order types and semantics
- **LIMIT BUY/SELL:** `quantity` is in ZIG, `price` in USDT. Tick/step sizes come from the exchange's symbol rules (Bybit `GET /v5/market/instruments-info`, MEXC `GET /api/v3/exchangeInfo`), cached via `precision.engine`. Round **down** to the allowed step and reject (don't silently change) anything below `minOrderQty` / min notional.
- **MARKET BUY:** spend a USDT amount (`quoteOrderQty`). Bybit: `marketUnit=quoteCoin`. MEXC: `quoteOrderQty`.
- **MARKET SELL:** sell a ZIG `quantity`.
- All numeric fields are decimal **strings**, validated with regex. Use a decimal library (e.g. `decimal.js`) for every calculation. No floating-point math on money or quantity.
- Every order carries a **client order ID** (idempotency): generate server-side with `client-oid.util.ts`, store it before sending, and treat a retry or timeout as "check status by clientOid" and not as "send again". A double-clicked button must never create two orders.

### Safety rails (enforced server-side, not just in the UI)
- Per-user, per-order **max notional in USDT** (`MAX_ORDER_USDT`, env) and a **daily cap** (`MAX_DAILY_USDT`).
- **Price-sanity guard on LIMIT orders:** reject if the price deviates more than `MAX_PRICE_DEVIATION_PCT` (default 10%) from the current mid price. This catches fat-finger entries.
- **Slippage guard on MARKET orders:** refuse if the book depth within `MAX_SLIPPAGE_PCT` of mid can't fill the size.
- **Balance pre-check** before sending: USDT for buys, ZIG for sells. Show a clear "insufficient balance" error without calling the exchange.
- **Confirmation step in the UI:** a summary modal (exchange(s), side, type, qty, price, estimated total, fees estimate) with an explicit Confirm button. Buy and sell must be visually unmistakable (green/red + word).
- **"Trade on both" must report per-exchange results.** If one fills and the other fails, show exactly that, with a retry for only the failed side. Never report overall success when one leg failed. Log each leg in `execution-log`.
- Per-user trading rate limit (e.g. 10 orders/min) via `@Throttle`, separate from the login limiter.
- A **kill switch:** an env flag `TRADING_ENABLED=false` makes every order endpoint return 503 without touching the exchanges.
- Orders can only be placed with keys belonging to the authenticated user (`req.user.id`); never accept a `userId` from the body.

### Order management
- Open orders list, order history, and **cancel** per order (and "cancel all open ZIG orders") on each exchange: Bybit `POST /v5/order/cancel` and `/v5/order/cancel-all`, MEXC `DELETE /api/v3/order` and `DELETE /api/v3/openOrders`.
- Live fill/status updates pushed to the UI: Bybit private WS `order` topic; MEXC private protobuf `spot@private.orders.v3.api.pb` and `spot@private.deals.v3.api.pb` (listenKey as described above). Fall back to REST polling of the order status if the socket drops.
- Order lifecycle states normalised through `order-state.util.ts`: NEW, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED. Persist to the `Order` table.
- Balances panel: USDT and ZIG, free and locked, per exchange (Bybit `GET /v5/account/wallet-balance`, MEXC `GET /api/v3/account`). The Bybit Unified account may need a funding-to-trading transfer note in the UI. Don't build transfers.

### Market data for the trading screen
- Live ticker, order book and recent trades for ZIG/USDT from both exchanges (Bybit public WS JSON; MEXC public protobuf WS `spot@public.aggre.depth/deals/bookTicker.v3.api.pb`), merged server-side and pushed to the browser via Socket.IO. Show the best bid and ask on each exchange side by side, so the user can see where each order will fill best.
- Prices shown to the user come from the server, never computed from stale client state. Mark a feed as "stale" if there is no update for more than 5 seconds, and disable Market orders while stale.

### Fees and compliance notes to surface in the UI
- Show maker/taker fee estimates (fetch from the exchange where available; otherwise config) and the final total after fees.
- Show a "ZIG token / trading involves risk" notice once. No financial advice text.

## FRONTEND SPEC (keep it simple)
- Edit `frontend/components/ConnectExchange.tsx` -> two cards (`bybit`, `mexc`), Tailwind, existing style.
- States per card: `not_connected` -> form; `connected` -> shows `keyHint`, connected-at, [Test] [Disconnect]; `error` -> inline message.
- Form fields: API Key, API Secret, Account password (re-auth), and for MEXC the withdrawal-disabled checkbox. One primary "Verify & connect" button, disabled while loading.
- Disconnect needs password + a confirm step; on success the backend also closes that user's exchange sockets and deletes the MEXC listenKey.
- No secrets in props, context, or global store.
- **Trading panel** (`TradingPanel.tsx`, simplified): Buy/Sell toggle, Limit/Market toggle, exchange selector (Bybit / MEXC / Both), amount input with % shortcuts (25/50/75/100% of the available balance), price input (Limit), estimated receive/total, then "Review order" -> confirmation modal -> result toast per exchange. Disabled and explained when an exchange isn't connected. Below it: open orders (with Cancel), recent history, balances.

## ACCEPTANCE CRITERIA / TESTS
Write Jest tests (backend) and a short manual checklist:
1. Ciphertext from user A cannot be decrypted under user B's AAD.
2. `GET /credentials` never contains `apiKey`, `apiSecret`, `encrypted*` (assert on JSON).
3. Saving a Bybit key with Withdraw permission is rejected and nothing is persisted.
4. Wrong password on save/delete -> 401, nothing changes; 6th attempt in a minute -> 429.
5. Grep test: run the app with a canary secret (`CANARY_SECRET_123`), exercise save/test/delete/error paths, assert the canary appears in **no** log line, alert payload, or HTTP response.
6. Startup fails with: missing/short `ENCRYPTION_KEY`, placeholder `JWT_SECRET`, `NODE_ENV=production` without `COOKIE_SECURE=true`.
7. MEXC protobuf frame decodes into a typed object for depth, deals, and private orders; a JSON control frame is not sent to the protobuf decoder; WS reconnects and resubscribes after a forced drop.
8. `git log -p` / `git grep` contain no real keys; `.env` still ignored.
9. `npm run build` and `npm test` pass in `backend/` and `frontend/`.
10. Trading unit tests: quantity and price round down to step size; below-minimum orders are rejected; decimal math has no float drift (`0.1 + 0.2` style cases); LIMIT price 50% off mid is rejected; order above `MAX_ORDER_USDT` is rejected; the 11th order in a minute returns 429; `TRADING_ENABLED=false` returns 503 and makes no exchange call.
11. Idempotency: sending the same order twice with the same client ID, or a retry after a simulated timeout, results in exactly one exchange order.
12. "Both" with one leg failing returns a per-exchange result and does not report success; retry sends only the failed leg.
13. A user cannot place, view or cancel another user's orders (try with a different user's order ID).
14. Manual test on each exchange with a **tiny live order** (a few USDT): limit buy placed far from the market, appears in open orders, then cancel; one small market buy and sell, and confirm the fills match the UI and the DB.

## DELIVERABLES
- Code changes + migration for `keyHint` and `CredentialAudit`.
- Updated `.env.example`, `docker-compose.yml` (no weak defaults, `COOKIE_SECURE`, `ENCRYPTION_KEY_PREV`).
- `docs/security.md`: threat model, key rotation runbook, how to create a **trade-only, IP-whitelisted** key on Bybit and MEXC.
- A summary of what changed and anything you could not verify. Do not claim tests pass without running them.

## NON-GOALS
No custody features, no withdrawals/transfers, no storing keys client-side, no extra exchanges, no other trading pairs, no margin/futures/leverage, no automated strategies or bots, no UI redesign beyond the connect cards and trading panel.

---

## Notes for you (not part of the prompt)
- **Bybit has no protobuf.** Only MEXC does. The prompt reflects that rather than forcing something that doesn't exist.
- The strongest protection is on the exchange side: **trade-only key, withdrawals off, IP whitelist = your server's IP.** Even a total server breach then can't move funds out. The app can verify this on Bybit but only ask you to confirm it on MEXC.
- Re-auth with password is what stops a hijacked session from overwriting/removing keys.
