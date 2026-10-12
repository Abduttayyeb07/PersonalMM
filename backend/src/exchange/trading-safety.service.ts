import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolPrecision } from './types';

type Book = { bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }> };
type Balance = { asset: string; free: number | string };

@Injectable()
export class TradingSafetyService {
  constructor(private config: ConfigService, private prisma: PrismaService) {}

  ensureEnabled() {
    if (this.config.get('TRADING_ENABLED') !== 'true') throw new ServiceUnavailableException('Trading is temporarily disabled');
  }

  async validate(input: {
    userId: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT'; quantity: string;
    price?: string; quoteOrderQty?: string; precision: SymbolPrecision; book: Book; balances: Balance[];
  }) {
    this.ensureEnabled();
    const { side, type, precision, book } = input;
    if (!book.bids[0] || !book.asks[0]) throw new ServiceUnavailableException('Market data is stale');
    const mid = new Decimal(book.bids[0].price).plus(book.asks[0].price).div(2);
    const quantity = new Decimal(input.quantity || '0');
    const price = input.price ? new Decimal(input.price) : undefined;
    const quoteQty = input.quoteOrderQty ? new Decimal(input.quoteOrderQty) : undefined;
    const notional = type === 'MARKET' && side === 'BUY' ? (quoteQty ?? new Decimal(0)) : quantity.mul(price ?? mid);
    if (!notional.isPositive() || ((side === 'SELL' || type === 'LIMIT') && !quantity.isPositive())) throw new BadRequestException('Order values must be positive');
    if ((side === 'SELL' || type === 'LIMIT') && quantity.lt(precision.minBaseQty)) throw new BadRequestException('Order quantity is below the exchange minimum');
    if (notional.lt(precision.minQuoteQty)) throw new BadRequestException('Order notional is below the exchange minimum');
    if (notional.gt(this.config.get('MAX_ORDER_USDT') ?? '100')) throw new BadRequestException('Order exceeds MAX_ORDER_USDT');
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const aggregate = await this.prisma.order.aggregate({ where: { userId: input.userId, createdAt: { gte: start }, status: { not: 'REJECTED' } }, _sum: { notionalUsdt: true } });
    const daily = new Decimal(aggregate._sum.notionalUsdt?.toString() ?? '0');
    if (daily.plus(notional).gt(this.config.get('MAX_DAILY_USDT') ?? '500')) throw new BadRequestException('Order exceeds MAX_DAILY_USDT');
    if (type === 'LIMIT' && price) {
      const deviation = price.minus(mid).abs().div(mid).mul(100);
      if (deviation.gt(this.config.get('MAX_PRICE_DEVIATION_PCT') ?? '10')) throw new BadRequestException('Limit price is too far from the current mid price');
    }
    if (type === 'MARKET') {
      const pct = new Decimal(this.config.get('MAX_SLIPPAGE_PCT') ?? '2').div(100);
      const levels = side === 'BUY' ? book.asks : book.bids;
      const boundary = side === 'BUY' ? mid.mul(new Decimal(1).plus(pct)) : mid.mul(new Decimal(1).minus(pct));
      let capacity = new Decimal(0);
      for (const level of levels) {
        const levelPrice = new Decimal(level.price);
        if ((side === 'BUY' && levelPrice.gt(boundary)) || (side === 'SELL' && levelPrice.lt(boundary))) break;
        capacity = capacity.plus(side === 'BUY' ? levelPrice.mul(level.qty) : level.qty);
      }
      if (capacity.lt(side === 'BUY' ? notional : quantity)) throw new BadRequestException('Insufficient book depth within slippage limit');
    }
    const asset = side === 'BUY' ? 'USDT' : 'ZIG';
    const available = new Decimal(input.balances.find((balance) => balance.asset === asset)?.free ?? 0);
    if (available.lt(side === 'BUY' ? notional : quantity)) throw new BadRequestException(`Insufficient ${asset} balance`);
    return { notional: notional.toFixed(), mid: mid.toFixed() };
  }
}
