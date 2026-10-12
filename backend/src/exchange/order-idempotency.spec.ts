import axios from 'axios';
import { NotFoundException } from '@nestjs/common';
import { MexcService } from '../mexc/mexc.service';
import { BybitService } from '../bybit/bybit.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const CREDS = { apiKey: 'k', apiSecret: 's' };

function deps() {
  const precision: any = {
    get: jest.fn().mockResolvedValue({ baseIncrement: '1', quoteIncrement: '0.00001', minBaseQty: '1', minQuoteQty: '1' }),
    round: jest.fn((v: string) => v),
  };
  const execLog: any = { startOrder: jest.fn().mockResolvedValue({ resolve: jest.fn(), reject: jest.fn() }) };
  const safety: any = { ensureEnabled: jest.fn(), validate: jest.fn().mockResolvedValue({ notional: '10', mid: '1' }) };
  const prisma: any = {
    order: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'row' }),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  return { precision, execLog, safety, prisma };
}

const book = { data: { bids: [['0.99', '1000']], asks: [['1.01', '1000']] } };
const account = { data: { balances: [{ asset: 'USDT', free: '1000', locked: '0' }] } };

describe('MEXC order idempotency', () => {
  function setup() {
    const d = deps();
    const svc = new MexcService(d.precision, d.execLog, d.safety, d.prisma);
    const post = jest.fn().mockResolvedValue({ data: { orderId: 'ex1', status: 'NEW' } });
    const get = jest.fn().mockImplementation(async (url: string) => (url.includes('depth') ? book : account));
    mockedAxios.get = get as any;
    mockedAxios.create = jest.fn(() => ({ post, get, delete: jest.fn() })) as any;
    return { svc, d, post, get };
  }

  it('returns the stored order instead of sending when the client ID already exists', async () => {
    const { svc, d, post } = setup();
    d.prisma.order.findUnique.mockResolvedValue({ exchangeOrderId: 'ex1', status: 'NEW' });
    const result: any = await svc.placeOrder('u', CREDS, 'BUY', 'LIMIT', '10', '1', undefined, 'same-key');
    expect(result.idempotent).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it('does not send a second order when a concurrent request wins the unique index', async () => {
    const { svc, d, post } = setup();
    d.prisma.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ exchangeOrderId: 'ex1', status: 'NEW' });
    d.prisma.order.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const result: any = await svc.placeOrder('u', CREDS, 'BUY', 'LIMIT', '10', '1', undefined, 'same-key');
    expect(result.idempotent).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it('checks status by client ID after a timeout and never re-posts', async () => {
    const { svc, post, get } = setup();
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    post.mockRejectedValue(Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED' }));
    get.mockImplementation(async (url: string) => {
      if (url.includes('/api/v3/order?')) return { data: { orderId: 'ex9', status: 'NEW' } };
      return url.includes('depth') ? book : account;
    });
    const result: any = await svc.placeOrder('u', CREDS, 'BUY', 'LIMIT', '10', '1', undefined, 'k2');
    expect(result.orderId).toBe('ex9');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refuses to cancel an order the user does not own', async () => {
    const { svc, d } = setup();
    d.prisma.order.findFirst.mockResolvedValue(null);
    await expect(svc.cancelOrder('attacker', CREDS, 'victim-order')).rejects.toBeInstanceOf(NotFoundException);
    expect(d.prisma.order.findFirst).toHaveBeenCalledWith({ where: { userId: 'attacker', exchange: 'mexc', exchangeOrderId: 'victim-order' } });
  });
});

describe('Bybit orders', () => {
  it('refuses to cancel an order the user does not own', async () => {
    const d = deps();
    const svc = new BybitService(d.precision, d.execLog, d.safety, d.prisma);
    d.prisma.order.findFirst.mockResolvedValue(null);
    await expect(svc.cancelOrder('attacker', CREDS, 'victim-order')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not send when the client ID already exists', async () => {
    const d = deps();
    const svc = new BybitService(d.precision, d.execLog, d.safety, d.prisma);
    d.prisma.order.findUnique.mockResolvedValue({ exchangeOrderId: 'b1', status: 'NEW' });
    const post = jest.fn();
    mockedAxios.create = jest.fn(() => ({ post, get: jest.fn() })) as any;
    const result: any = await svc.placeOrder('u', CREDS, 'BUY', 'LIMIT', '10', '1', undefined, 'same-key');
    expect(result.idempotent).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});
