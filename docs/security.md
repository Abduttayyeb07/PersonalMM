# Exchange credential security

## Security model

The application supports Bybit and MEXC spot trading for the hard-coded `ZIGUSDT` market. It never supports withdrawals, transfers, margin, futures, leverage, or a client-selected symbol.

Credentials are accepted only over authenticated, CSRF-protected requests. The browser keeps them in component memory and clears them after every submission. The API never returns stored key material. It returns only the exchange, timestamps, and a `…1234` hint stored at save time.

The database stores AES-256-GCM ciphertext as `v1:<base64>`. Authenticated additional data is `${userId}:${exchange}`, so moving a row to another user or exchange makes authentication fail. A database dump is insufficient without the encryption key. A fully compromised application host can still sign trades, so exchange-side withdrawal disablement and IP binding are mandatory and remain the most important containment controls.

Sensitive credential changes require the account password again and are limited to five attempts per minute per authenticated client. State-changing requests require `X-Requested-With: zig`; the session cookie is HTTP-only, Secure in production, and SameSite Strict. Audit rows contain action, exchange, user, IP, user agent, and timestamp—never key material.

## Creating exchange keys

### Bybit

1. Create a system-generated API key for the account that holds the trading balance.
2. Enable Spot trade permission only. Do not enable withdrawal or transfer permissions.
3. Bind the key to the public egress IP of this server. Do not use an unrestricted IP entry.
4. Paste the key and secret into the Bybit card. The server checks `/v5/user/query-api` and refuses withdrawal-enabled, read-only, or non-IP-bound keys.

Unified-account balances are usable for spot. Funds left only in the Funding account may need to be moved using Bybit's own interface; this application does not build transfers.

### MEXC

1. Create a Spot API key with trading enabled.
2. Explicitly disable withdrawals and all non-spot permissions.
3. Add the server's public egress IP to the key allowlist.
4. Confirm the safety checkbox before saving. MEXC's account API verifies validity and `canTrade`, but does not reliably expose withdrawal permission, so the server cannot independently prove that setting.

## Encryption-key rotation

1. Back up the database and confirm the backup is restorable.
2. Keep the old key in `ENCRYPTION_KEY_PREV` and place a newly generated 64-hex-character key in `ENCRYPTION_KEY`.
3. Restart one backend instance and verify it can read existing credentials through the decrypt-only previous key.
4. From `backend/`, run `npm run rotate-encryption-key` once. The script decrypts each row with current/previous key and re-encrypts it with the current key while preserving its AAD.
5. Test both exchange connections and a read-only balance request.
6. Remove `ENCRYPTION_KEY_PREV` and restart all instances. Destroy the old key according to the deployment's secret-retention policy.

Never reverse steps 2 and 4, and never remove the previous key before every row has been rotated.

## Deployment checklist

- Use a unique PostgreSQL password; `zigpass` is rejected in production.
- Set `COOKIE_SECURE=true`, a random `JWT_SECRET` of at least 32 characters, and a random 64-hex-character `ENCRYPTION_KEY`.
- Keep PostgreSQL internal to Compose; it has no published port.
- Terminate TLS at the reverse proxy and route `/api` and `/socket.io` only to the backend.
- Start with `TRADING_ENABLED=false`; set caps and slippage limits before enabling it.
- Confirm the CSP WebSocket domain in `frontend/next.config.ts` matches the production hostname.
- Do not add analytics, session replay, or third-party scripts to the credential page.

## Manual verification

- Connect each exchange with a dedicated, IP-bound, trade-only test key.
- Confirm wrong re-authentication passwords cannot save or delete credentials.
- Confirm responses and logs do not contain a canary secret.
- Place a tiny limit buy away from market, verify it appears in open orders, then cancel it.
- Place one small market buy and sell on each exchange and reconcile fills, fees, balances, and persisted order states.
- Force each upstream WebSocket closed and confirm reconnect, resubscription, and stale-feed behavior.

Live-order testing spends real funds and was intentionally not automated.
