# Spec conformance audit

Run 2026-10-12T15:52:28.857Z

## real-30d-default: PASS

30 days of real ZIGUSDT minutes, spec config (12,500 ZIG rungs). 135 cycles · profit $2588.14 · 330 orders · 283 fills · 0 kill(s) · netted 0 · partial-sell exceptions 0

| Check | Result | Evidence |
|---|---|---|
| Client order ids follow the spec format and are never re-sent | pass | 330 orders, every id unique and well-formed |
| Rule 1: sell first; no rung buys ZIG it has not sold | pass | every rung opened with a sell; no buy without a prior sell |
| Rule 3: never buy above target, never sell below the rung | pass | 330 orders all inside their caps and floors |
| Rule 4: full fill gates the next step (except the partial-sell exception) | pass | every buyback followed a full sell; every re-sell followed a full buyback |
| A rung never has more than one live order | pass | never more than one live order per rung |
| At start-up and on arming, sells rest above the market (no dumping lower rungs) | pass | every first sell rested above the market |
| Rule 5: the engine never trades with itself | pass | our highest buy was always below our lowest sell |
| Rule 6: every order is real (none placed to be cancelled) | pass | 0 cancels for 330 orders (0.0%), all from pegging, the exception or the kill switch, none within 2 s of placing |
| Never spends USDT it did not earn from its own sells | pass | lowest quote balance 0.0000 (start 0) |
| Never holds more ZIG than it started with (beyond lot rounding) | pass | highest ZIG balance 587500.39644 (start 587500) |
| Rule 2: same quantity back; profit taken in USDT only | pass | 135 cycles, each returned the ZIG it sold (within one lot) |
| Every completed cycle has net profit >= 0 | pass | 135 cycles, lowest profit 17.1361 |
| Every cycle's profit matches the formula | pass | all cycles match proceeds-after-fee minus buyback cost |
| No unexpected kill-switch events | pass | no kill-switch events |
| Invariants I1-I10 clean at the end | pass | no breaches |
| The rung table is rebuildable from fill events alone | pass | rebuilt state matches |
| Engine still running | pass | RUNNING |

## real-30d-5000zig: PASS

30 days of real minutes, your paper setup: 5,000 ZIG, 500 ZIG rungs. 94 cycles · profit $69.15 · 208 orders · 198 fills · 0 kill(s) · netted 0 · partial-sell exceptions 0

| Check | Result | Evidence |
|---|---|---|
| Client order ids follow the spec format and are never re-sent | pass | 208 orders, every id unique and well-formed |
| Rule 1: sell first; no rung buys ZIG it has not sold | pass | every rung opened with a sell; no buy without a prior sell |
| Rule 3: never buy above target, never sell below the rung | pass | 208 orders all inside their caps and floors |
| Rule 4: full fill gates the next step (except the partial-sell exception) | pass | every buyback followed a full sell; every re-sell followed a full buyback |
| A rung never has more than one live order | pass | never more than one live order per rung |
| At start-up and on arming, sells rest above the market (no dumping lower rungs) | pass | every first sell rested above the market |
| Rule 5: the engine never trades with itself | pass | our highest buy was always below our lowest sell |
| Rule 6: every order is real (none placed to be cancelled) | pass | 0 cancels for 208 orders (0.0%), all from pegging, the exception or the kill switch, none within 2 s of placing |
| Never spends USDT it did not earn from its own sells | pass | lowest quote balance 0.0000 (start 0) |
| Never holds more ZIG than it started with (beyond lot rounding) | pass | highest ZIG balance 5000.50297 (start 5000) |
| Rule 2: same quantity back; profit taken in USDT only | pass | 94 cycles, each returned the ZIG it sold (within one lot) |
| Every completed cycle has net profit >= 0 | pass | 94 cycles, lowest profit 0.6850 |
| Every cycle's profit matches the formula | pass | all cycles match proceeds-after-fee minus buyback cost |
| No unexpected kill-switch events | pass | no kill-switch events |
| Invariants I1-I10 clean at the end | pass | no breaches |
| The rung table is rebuildable from fill events alone | pass | rebuilt state matches |
| Engine still running | pass | RUNNING |

## stress-oscillation: PASS

Price lands exactly on rung prices again and again, 3-tick spread, random partial fills, lagging public book. 1187 cycles · profit $1967.10 · 2867 orders · 3137 fills · 0 kill(s) · netted 0 · partial-sell exceptions 363

| Check | Result | Evidence |
|---|---|---|
| Client order ids follow the spec format and are never re-sent | pass | 2867 orders, every id unique and well-formed |
| Rule 1: sell first; no rung buys ZIG it has not sold | pass | every rung opened with a sell; no buy without a prior sell |
| Rule 3: never buy above target, never sell below the rung | pass | 2867 orders all inside their caps and floors |
| Rule 4: full fill gates the next step (except the partial-sell exception) | pass | every buyback followed a full sell; every re-sell followed a full buyback |
| A rung never has more than one live order | pass | never more than one live order per rung |
| At start-up and on arming, sells rest above the market (no dumping lower rungs) | pass | every first sell rested above the market |
| Rule 5: the engine never trades with itself | pass | our highest buy was always below our lowest sell |
| Rule 6: every order is real (none placed to be cancelled) | pass | 815 cancels for 2867 orders (28.4%), all from pegging, the exception or the kill switch, none within 2 s of placing |
| Never spends USDT it did not earn from its own sells | pass | lowest quote balance 0.0000 (start 0) |
| Never holds more ZIG than it started with (beyond lot rounding) | pass | highest ZIG balance 47000 (start 47000) |
| Rule 2: same quantity back; profit taken in USDT only | pass | 1187 cycles, each returned the ZIG it sold (within one lot) |
| Every completed cycle has net profit >= 0 | pass | 1187 cycles, lowest profit 0.4899 |
| Every cycle's profit matches the formula | pass | all cycles match proceeds-after-fee minus buyback cost |
| No unexpected kill-switch events | pass | no kill-switch events |
| Invariants I1-I10 clean at the end | pass | no breaches |
| The rung table is rebuildable from fill events alone | pass | rebuilt state matches |
| Engine still running | pass | RUNNING |

## stress-gaps: PASS

Gaps through many rungs, below the floor, above the top, with partial fills. 67 cycles · profit $984.76 · 212 orders · 214 fills · 0 kill(s) · netted 0 · partial-sell exceptions 33

| Check | Result | Evidence |
|---|---|---|
| Client order ids follow the spec format and are never re-sent | pass | 212 orders, every id unique and well-formed |
| Rule 1: sell first; no rung buys ZIG it has not sold | pass | every rung opened with a sell; no buy without a prior sell |
| Rule 3: never buy above target, never sell below the rung | pass | 212 orders all inside their caps and floors |
| Rule 4: full fill gates the next step (except the partial-sell exception) | pass | every buyback followed a full sell; every re-sell followed a full buyback |
| A rung never has more than one live order | pass | never more than one live order per rung |
| At start-up and on arming, sells rest above the market (no dumping lower rungs) | pass | every first sell rested above the market |
| Rule 5: the engine never trades with itself | pass | our highest buy was always below our lowest sell |
| Rule 6: every order is real (none placed to be cancelled) | pass | 58 cancels for 212 orders (27.4%), all from pegging, the exception or the kill switch, none within 2 s of placing |
| Never spends USDT it did not earn from its own sells | pass | lowest quote balance 0.0000 (start 0) |
| Never holds more ZIG than it started with (beyond lot rounding) | pass | highest ZIG balance 47000 (start 47000) |
| Rule 2: same quantity back; profit taken in USDT only | pass | 67 cycles, each returned the ZIG it sold (within one lot) |
| Every completed cycle has net profit >= 0 | pass | 67 cycles, lowest profit 1.3990 |
| Every cycle's profit matches the formula | pass | all cycles match proceeds-after-fee minus buyback cost |
| No unexpected kill-switch events | pass | no kill-switch events |
| Invariants I1-I10 clean at the end | pass | no breaches |
| The rung table is rebuildable from fill events alone | pass | rebuilt state matches |
| Engine still running | pass | RUNNING |

## drill-crash-mid-fill: PASS

Engine dies; sells fill while it is down; a standby takes over. 4 cycles · profit $6.78 · 44 orders · 8 fills · 0 kill(s) · netted 0 · partial-sell exceptions 0

| Check | Result | Evidence |
|---|---|---|
| Client order ids follow the spec format and are never re-sent | pass | 44 orders, every id unique and well-formed |
| Rule 1: sell first; no rung buys ZIG it has not sold | pass | every rung opened with a sell; no buy without a prior sell |
| Rule 3: never buy above target, never sell below the rung | pass | 44 orders all inside their caps and floors |
| Rule 4: full fill gates the next step (except the partial-sell exception) | pass | every buyback followed a full sell; every re-sell followed a full buyback |
| A rung never has more than one live order | pass | never more than one live order per rung |
| At start-up and on arming, sells rest above the market (no dumping lower rungs) | pass | every first sell rested above the market |
| Rule 5: the engine never trades with itself | pass | our highest buy was always below our lowest sell |
| Rule 6: every order is real (none placed to be cancelled) | pass | 0 cancels for 44 orders (0.0%), all from pegging, the exception or the kill switch, none within 2 s of placing |
| Never spends USDT it did not earn from its own sells | pass | lowest quote balance 0.0000 (start 0) |
| Never holds more ZIG than it started with (beyond lot rounding) | pass | highest ZIG balance 47000.03596 (start 47000) |
| Rule 2: same quantity back; profit taken in USDT only | pass | 4 cycles, each returned the ZIG it sold (within one lot) |
| Every completed cycle has net profit >= 0 | pass | 4 cycles, lowest profit 1.6594 |
| Every cycle's profit matches the formula | pass | all cycles match proceeds-after-fee minus buyback cost |
| No unexpected kill-switch events | pass | no kill-switch events |
| Invariants I1-I10 clean at the end | pass | no breaches |
| The rung table is rebuildable from fill events alone | pass | rebuilt state matches |
| Engine still running | pass | RUNNING |

## drill-private-ws-cut-5min: PASS

Private fill feed cut for 5 minutes while fills happen; REST poll and self-healing must recover. 0 cycles · profit $0.00 · 70 orders · 2 fills · 1 kill(s) · netted 0 · partial-sell exceptions 0

| Check | Result | Evidence |
|---|---|---|
| Client order ids follow the spec format and are never re-sent | pass | 70 orders, every id unique and well-formed |
| Rule 1: sell first; no rung buys ZIG it has not sold | pass | every rung opened with a sell; no buy without a prior sell |
| Rule 3: never buy above target, never sell below the rung | pass | 70 orders all inside their caps and floors |
| Rule 4: full fill gates the next step (except the partial-sell exception) | pass | every buyback followed a full sell; every re-sell followed a full buyback |
| A rung never has more than one live order | pass | never more than one live order per rung |
| At start-up and on arming, sells rest above the market (no dumping lower rungs) | pass | every first sell rested above the market |
| Rule 5: the engine never trades with itself | pass | our highest buy was always below our lowest sell |
| Rule 6: every order is real (none placed to be cancelled) | pass | 34 cancels for 70 orders (48.6%), all from pegging, the exception or the kill switch, none within 2 s of placing |
| Never spends USDT it did not earn from its own sells | pass | lowest quote balance 0.0000 (start 0) |
| Never holds more ZIG than it started with (beyond lot rounding) | pass | highest ZIG balance 47000 (start 47000) |
| Rule 2: same quantity back; profit taken in USDT only | pass | 0 cycles, each returned the ZIG it sold (within one lot) |
| Every completed cycle has net profit >= 0 | pass | 0 cycles, lowest profit — |
| Every cycle's profit matches the formula | pass | all cycles match proceeds-after-fee minus buyback cost |
| No unexpected kill-switch events | pass | 1 kill(s), all provoked by the scenario |
| Invariants I1-I10 clean at the end | pass | no breaches |
| The rung table is rebuildable from fill events alone | pass | rebuilt state matches |
| Engine still running | pass | RUNNING |
| Drill: fills made during the outage are in the ledger and the engine resumed on its own | pass | 2/2 fills recorded, status RUNNING |

## drill-market-ws-cut-5min: PASS

Market data cut for 5 minutes: the engine must stop trading blind, then recover on its own. 0 cycles · profit $0.00 · 68 orders · 0 fills · 1 kill(s) · netted 0 · partial-sell exceptions 0

| Check | Result | Evidence |
|---|---|---|
| Client order ids follow the spec format and are never re-sent | pass | 68 orders, every id unique and well-formed |
| Rule 1: sell first; no rung buys ZIG it has not sold | pass | every rung opened with a sell; no buy without a prior sell |
| Rule 3: never buy above target, never sell below the rung | pass | 68 orders all inside their caps and floors |
| Rule 4: full fill gates the next step (except the partial-sell exception) | pass | every buyback followed a full sell; every re-sell followed a full buyback |
| A rung never has more than one live order | pass | never more than one live order per rung |
| At start-up and on arming, sells rest above the market (no dumping lower rungs) | pass | every first sell rested above the market |
| Rule 5: the engine never trades with itself | pass | our highest buy was always below our lowest sell |
| Rule 6: every order is real (none placed to be cancelled) | pass | 34 cancels for 68 orders (50.0%), all from pegging, the exception or the kill switch, none within 2 s of placing |
| Never spends USDT it did not earn from its own sells | pass | lowest quote balance 0.0000 (start 0) |
| Never holds more ZIG than it started with (beyond lot rounding) | pass | highest ZIG balance 47000 (start 47000) |
| Rule 2: same quantity back; profit taken in USDT only | pass | 0 cycles, each returned the ZIG it sold (within one lot) |
| Every completed cycle has net profit >= 0 | pass | 0 cycles, lowest profit — |
| Every cycle's profit matches the formula | pass | all cycles match proceeds-after-fee minus buyback cost |
| No unexpected kill-switch events | pass | 1 kill(s), all provoked by the scenario |
| Invariants I1-I10 clean at the end | pass | no breaches |
| The rung table is rebuildable from fill events alone | pass | rebuilt state matches |
| Engine still running | pass | RUNNING |
| Drill: stopped while blind, resumed on its own when data returned | pass | kills 1, final status RUNNING |

## drill-second-instance: PASS

A second engine for the same pair starts while the first runs. 0 cycles · profit $0.00 · 36 orders · 2 fills · 0 kill(s) · netted 0 · partial-sell exceptions 0

| Check | Result | Evidence |
|---|---|---|
| Client order ids follow the spec format and are never re-sent | pass | 36 orders, every id unique and well-formed |
| Rule 1: sell first; no rung buys ZIG it has not sold | pass | every rung opened with a sell; no buy without a prior sell |
| Rule 3: never buy above target, never sell below the rung | pass | 36 orders all inside their caps and floors |
| Rule 4: full fill gates the next step (except the partial-sell exception) | pass | every buyback followed a full sell; every re-sell followed a full buyback |
| A rung never has more than one live order | pass | never more than one live order per rung |
| At start-up and on arming, sells rest above the market (no dumping lower rungs) | pass | every first sell rested above the market |
| Rule 5: the engine never trades with itself | pass | our highest buy was always below our lowest sell |
| Rule 6: every order is real (none placed to be cancelled) | pass | 0 cancels for 36 orders (0.0%), all from pegging, the exception or the kill switch, none within 2 s of placing |
| Never spends USDT it did not earn from its own sells | pass | lowest quote balance 0.0000 (start 0) |
| Never holds more ZIG than it started with (beyond lot rounding) | pass | highest ZIG balance 47000 (start 47000) |
| Rule 2: same quantity back; profit taken in USDT only | pass | 0 cycles, each returned the ZIG it sold (within one lot) |
| Every completed cycle has net profit >= 0 | pass | 0 cycles, lowest profit — |
| Every cycle's profit matches the formula | pass | all cycles match proceeds-after-fee minus buyback cost |
| No unexpected kill-switch events | pass | no kill-switch events |
| Invariants I1-I10 clean at the end | pass | no breaches |
| The rung table is rebuildable from fill events alone | pass | rebuilt state matches |
| Engine still running | pass | RUNNING |
| Drill: the second instance never places an order | pass | second instance status STOPPED, orders placed 0 |

## drill-duplicate-fill-and-rate-limits: PASS

Every fill replayed twice; bursts of rate-limit errors during placement. 0 cycles · profit $0.00 · 34 orders · 3 fills · 0 kill(s) · netted 0 · partial-sell exceptions 0

| Check | Result | Evidence |
|---|---|---|
| Client order ids follow the spec format and are never re-sent | pass | 34 orders, every id unique and well-formed |
| Rule 1: sell first; no rung buys ZIG it has not sold | pass | every rung opened with a sell; no buy without a prior sell |
| Rule 3: never buy above target, never sell below the rung | pass | 34 orders all inside their caps and floors |
| Rule 4: full fill gates the next step (except the partial-sell exception) | pass | every buyback followed a full sell; every re-sell followed a full buyback |
| A rung never has more than one live order | pass | never more than one live order per rung |
| At start-up and on arming, sells rest above the market (no dumping lower rungs) | pass | every first sell rested above the market |
| Rule 5: the engine never trades with itself | pass | our highest buy was always below our lowest sell |
| Rule 6: every order is real (none placed to be cancelled) | pass | 0 cancels for 34 orders (0.0%), all from pegging, the exception or the kill switch, none within 2 s of placing |
| Never spends USDT it did not earn from its own sells | pass | lowest quote balance 0.0000 (start 0) |
| Never holds more ZIG than it started with (beyond lot rounding) | pass | highest ZIG balance 47000 (start 47000) |
| Rule 2: same quantity back; profit taken in USDT only | pass | 0 cycles, each returned the ZIG it sold (within one lot) |
| Every completed cycle has net profit >= 0 | pass | 0 cycles, lowest profit — |
| Every cycle's profit matches the formula | pass | all cycles match proceeds-after-fee minus buyback cost |
| No unexpected kill-switch events | pass | no kill-switch events |
| Invariants I1-I10 clean at the end | pass | no breaches |
| The rung table is rebuildable from fill events alone | pass | rebuilt state matches |
| Engine still running | pass | RUNNING |
