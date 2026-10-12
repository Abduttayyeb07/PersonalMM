# Sell-first grid engine — runbook

Implements the "Sell-First Grid Engine — Final Build Spec" (12 Oct 2026). Code: `backend/src/engine/`, CLI: `backend/scripts/engine.ts`, pair configs: `backend/pairs/`, ledger schema (plain SQL, no ORM): `backend/sql/`.

## Users are independent

Every engine instance is scoped to one app user: `<userId>/<pairId>`. Ledger rows, leases, the kill switch (including "kill all my pairs"), approvals and reports are keyed by that scope, so one user can never see, stop or trade another user's engine. Live trading uses **that user's own Bybit key** as connected in the app (AES-256-GCM, bound to the user by AAD). There are no shared API keys.

## Commands (run from `backend/`)

```powershell
npm run engine -- backtest --days 30                     # real Bybit 1-min candles: live config vs step 2%
npm run engine -- onboard                                # onboarding checklist (add --with-keys --user e for the fee tier)
npm run engine -- run --mode paper --fresh --user abt@gmail.com --base 120000   # live data, simulated fills
npm run engine -- status --paper --user abt@gmail.com
npm run engine -- kill --by zoya --user abt@gmail.com [--all] [--paper]
npm run engine -- resume --by subhan --user abt@gmail.com
npm run engine -- report --user abt@gmail.com
```

Going live (only after stages 1–3 pass):

1. The user connects a **trade-only, IP-bound, no-withdrawal** Bybit key in the app (sub-account per pair).
2. `npm run engine -- approve --user <email> --approvers "bilal,zahoor"` and commit `pairs/approvals.json` through review.
3. `npm run engine -- init --user <email>` records starting balances (genesis) once.
4. `ENGINE_LIVE_CONFIRM=ZIGUSDT-BYBIT npm run engine -- run --mode live --user <email>`. Start with `rung_size_base: 1000`.

Run one process per user and pair. Start a second identical process on another host as the warm standby: it waits for the lease and takes over within 15 s if the first dies.

## What maps to the spec

| Spec | Where |
|---|---|
| Config, validation, hash, two-approver check (I10) | `config/engine-config.ts`, `pairs/*.yaml`, `pairs/approvals.json` |
| Lattice, sells round up / buys round down | `lattice.ts` |
| Rung state machine, arming, pegging, stuck-partial-sell exception, netting | `engine-instance.ts`, `rung-accounting.ts` |
| Client order IDs `ZIGUSDT-A+01-C0007-S[-rN]`, never reused | `order-id.ts` |
| Risk gate incl. fencing epoch, self-cross, base cap, balances | `risk/risk-gate.ts` |
| Ledger: atomic fill + transition, rebuild from fills, append-only audit | `ledger/`, `sql/001_engine_ledger.sql` |
| Lease (15 s TTL, 5 s renew, DB clock), restart procedure | `supervisor/lease.ts`, `engine-instance.ts` |
| Invariants I1–I10 and kill switch | `invariants.ts`, `engine-instance.ts` |
| Supervisor timers, heartbeat, self-healing, daily summary | `supervisor/runner.ts` |
| Bybit adapter (post-only, SMP, pacing, WS + REST cross-check) | `venue/bybit-venue.ts` |
| Simulated venue, backtest, paper mode | `venue/sim-venue.ts`, `backtest/`, `venue/paper-venue.ts` |
| Weekly report, sweep record | `reports.ts`, CLI `report` / `sweep` |

Tests: `npx jest src/engine` covers the spec table, full cycles, pegging caps, the partial-sell exception, a crash with fills while down, a second instance never trading, fencing, duplicate fills, rate limits, kill triggers, netting, rebuilding rungs from fills, and user isolation.

## Findings from building it

- **Spec table rounding.** The table rounds to the nearest tick; the rule (sells up, buys down) is what trades, so e.g. A+03 sells at 0.06557, not 0.06556. Ladder A's top rung is 0.09918, not 0.09752.
- **Buyback rounding residual.** Rounding buybacks *up* to the lot (so a cycle never returns less ZIG than it sold) gains up to 0.01 ZIG per cycle. Over ~100 cycles that exceeds `dust_tolerance_base: 1`, so I1 accounts for the measured residual explicitly and flags any cycle whose residual exceeds one lot.
- **30-day backtest** (12 Sep – 12 Oct 2026, ZIG 0.0453 → 0.0590): live config 135 cycles, $2,588 realised; step 2% 324 cycles, $4,024. No kills, every cycle matches the formula exactly. Price started below the 0.05 floor.
- **Onboarding fails at full size.** Median hourly volume is ~170k ZIG; a 12,500-ZIG rung is 7.3% of it, above the 5% rule. 1,000 ZIG (stage 3) passes.
- **Netting is rare.** With a book that shows our own orders, the pegging rules already avoid equal prices. It becomes reachable when the spread straddles a shared price and the public book lags our order (ZIG's spread is ~5 ticks), so it is implemented and tested.
- **Bybit WebSocket host.** This network blocks `stream.bybit.com`; `BYBIT_WS_HOST=wss://stream.bytick.com` works.

## Not built yet / decisions needed

- Level-2 self-tuning and the Advisor (nightly simulation, shadow lattices, proposals) — spec weeks 2–4. Peg interval, armed rungs and poll interval are fixed inside their config bounds.
- Weekly sweep is **recorded**, not executed: moving profit between sub-accounts needs a transfer permission, which conflicts with "trade-only key". Leadership to decide.
- Live dashboard UI (the daily Telegram summary covers it for now); per-user Telegram routing (alerts go to the operator chat, tagged with the user).
- Unverified against the live venue (needs a funded key): post-only + `smpType` accepted, spot buy fee charged in ZIG, `orderLinkId` behaviour, price-limit rejections for far rungs (mapped to a deferral, not a kill), open-order limit.
- Spec open items still open: partial-buyback handling, floor/top confirmation, retiring the v1 ladder.
