import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TradingSafetyService } from './trading-safety.service';

const precision: any = { minBaseQty: '1', minQuoteQty: '1', baseIncrement: '1', quoteIncrement: '0.001' };
const base = {
  userId: 'user', side: 'BUY' as const, type: 'LIMIT' as const, quantity: '10', price: '1', precision,
  book: { bids: [{ price: 0.99, qty: 1000 }], asks: [{ price: 1.01, qty: 1000 }] },
  balances: [{ asset: 'USDT', free: 1000 }],
};

function service(values: Record<string, string> = {}) {
  const config: any = { get: (key: string) => values[key] ?? ({ TRADING_ENABLED: 'true', MAX_ORDER_USDT: '100', MAX_DAILY_USDT: '500', MAX_PRICE_DEVIATION_PCT: '10', MAX_SLIPPAGE_PCT: '2' } as any)[key] };
  const prisma: any = { order: { aggregate: jest.fn().mockResolvedValue({ _sum: { notionalUsdt: null } }) } };
  return new TradingSafetyService(config, prisma);
}

describe('TradingSafetyService', () => {
  it('stops before exchange access when the kill switch is off', async () => {
    await expect(service({ TRADING_ENABLED: 'false' }).validate(base)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('rejects a limit price 50% away from mid', async () => {
    await expect(service().validate({ ...base, price: '1.5' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects orders above the per-order maximum', async () => {
    await expect(service({ MAX_ORDER_USDT: '5' }).validate(base)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects below-minimum orders', async () => {
    await expect(service().validate({ ...base, quantity: '0.5', price: '1' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
