import Decimal from 'decimal.js';
import { PairConfig, SharedConfig } from '../config/engine-config';
import { RungRecord, owed } from '../rung-accounting';
import { Balances, Side, VenueSpecs } from '../types';
import { Lease } from '../supervisor/lease';

export interface OrderRequest {
  rung: RungRecord;
  side: Side;
  price: Decimal;
  qty: Decimal;
  epoch: number;
}

export type GateCode =
  | 'STALE_EPOCH'
  | 'FIRST_ORDER_NOT_SELL'
  | 'SELL_BELOW_RUNG'
  | 'BUY_ABOVE_TARGET'
  | 'OUTSIDE_RANGE'
  | 'SELF_CROSS'
  | 'BASE_CAP'
  | 'GLOBAL_LIMIT'
  | 'BELOW_MINIMUM'
  | 'INSUFFICIENT_BALANCE'
  | 'BAD_STATE';

export type GateResult = { ok: true } | { ok: false; code: GateCode; message: string };

export interface GateContext {
  rungs: RungRecord[];
  balances: Balances;
}

/**
 * Every order passes through here. The engine cannot reach the venue any other way.
 * A SELF_CROSS rejection is a kill-switch trigger: the engine's own deferral/netting logic must
 * have prevented it, so reaching the gate means a logic bug.
 */
export class RiskGate {
  constructor(
    private readonly cfg: PairConfig,
    private readonly shared: SharedConfig,
    private readonly specs: VenueSpecs,
    private readonly lease: Lease,
    private readonly holder: string,
    private readonly venueName: string,
    /** `<ownerId>/<pairId>`: the lease this gate fences on. */
    private readonly scope: string,
  ) {}

  private reject(code: GateCode, message: string): GateResult {
    return { ok: false, code, message };
  }

  async check(req: OrderRequest, ctx: GateContext): Promise<GateResult> {
    const { rung, side, price, qty } = req;

    // Fencing: only the current lease epoch may send orders.
    if (!(await this.lease.verify(this.scope, this.holder, req.epoch))) {
      return this.reject('STALE_EPOCH', `epoch ${req.epoch} is not the current lease`);
    }

    // Rule 1/4: a rung's first order is a sell; a buy needs a sell that has filled.
    if (side === 'SELL' && rung.state !== 'SELL_LIVE') return this.reject('BAD_STATE', `sell on rung in ${rung.state}`);
    if (side === 'BUY') {
      if (rung.state !== 'BUY_LIVE') return this.reject('FIRST_ORDER_NOT_SELL', 'a buy needs a prior sell on this rung');
      if (rung.soldQty.isZero()) return this.reject('FIRST_ORDER_NOT_SELL', 'nothing was sold on this rung');
    }

    // I7: rung price discipline.
    if (side === 'SELL') {
      if (price.lt(rung.sellPrice)) return this.reject('SELL_BELOW_RUNG', `sell ${price} below rung ${rung.sellPrice}`);
      if (price.lt(this.cfg.floorPrice)) return this.reject('OUTSIDE_RANGE', 'sell below floor');
    } else if (price.gt(rung.buyPrice)) {
      return this.reject('BUY_ABOVE_TARGET', `buy ${price} above target ${rung.buyPrice}`);
    }
    if (!price.isPositive() || !qty.isPositive()) return this.reject('BELOW_MINIMUM', 'price and quantity must be positive');

    // Venue minimums (config validation should make these impossible; this is the backstop).
    if (qty.lt(this.specs.lot) || price.mul(qty).lt(this.specs.minOrderValue)) {
      return this.reject('BELOW_MINIMUM', 'order is below the venue minimum');
    }

    // I6: never rest an order that could match one of ours.
    let lowestSell: Decimal | null = null;
    let highestBuy: Decimal | null = null;
    for (const other of ctx.rungs) {
      if (other.key === rung.key || !other.order) continue;
      if (other.order.side === 'SELL' && (lowestSell === null || other.order.price.lt(lowestSell))) lowestSell = other.order.price;
      if (other.order.side === 'BUY' && (highestBuy === null || other.order.price.gt(highestBuy))) highestBuy = other.order.price;
    }
    if (side === 'BUY' && lowestSell !== null && price.gte(lowestSell)) {
      return this.reject('SELF_CROSS', `buy ${price} at or above our sell ${lowestSell}`);
    }
    if (side === 'SELL' && highestBuy !== null && price.lte(highestBuy)) {
      return this.reject('SELF_CROSS', `sell ${price} at or below our buy ${highestBuy}`);
    }

    const remainingOf = (r: RungRecord) => r.legQty.minus(r.legFilled);
    if (side === 'SELL') {
      // Hard cap: base owed on every rung plus base still resting in live sells plus this order.
      let committed = qty.plus(owed(rung));
      let liveSells = new Decimal(0);
      for (const other of ctx.rungs) {
        if (other.key === rung.key) continue;
        committed = committed.plus(owed(other));
        if (other.order?.side === 'SELL') {
          committed = committed.plus(remainingOf(other));
          liveSells = liveSells.plus(remainingOf(other));
        }
      }
      if (committed.gt(this.cfg.maxBaseOwed)) return this.reject('BASE_CAP', `would exceed max_base_owed ${this.cfg.maxBaseOwed}`);
      // Never sell base we do not hold (or have already promised to other live sells).
      if (ctx.balances.base.minus(liveSells).lt(qty)) return this.reject('INSUFFICIENT_BALANCE', `not enough base for this sell: need ${qty.plus(liveSells).toFixed()} incl. live sells, hold ${ctx.balances.base.toFixed()}`);
    } else {
      // Buyback must be fundable from the quote we hold, including other live buybacks.
      let committed = price.mul(qty);
      for (const other of ctx.rungs) {
        if (other.key !== rung.key && other.order?.side === 'BUY') committed = committed.plus(other.order.price.mul(remainingOf(other)));
      }
      if (ctx.balances.quote.lt(committed)) return this.reject('INSUFFICIENT_BALANCE', `not enough quote for this buyback: need ${committed.toFixed(4)} (this ${price.mul(qty).toFixed(4)}), hold ${ctx.balances.quote.toFixed(4)}`);
    }

    // Global limit: quote held on the venue across all pairs (this process sees its own pair).
    const cap = this.shared.maxQuoteOnVenueUsd[this.venueName];
    if (cap && ctx.balances.quote.gt(cap)) return this.reject('GLOBAL_LIMIT', `quote on venue exceeds ${cap}`);

    return { ok: true };
  }
}
