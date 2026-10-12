import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { MexcService } from './mexc.service';
import { PrecisionEngine } from '../exchange/precision.engine';
import { ExecutionLogService } from '../execution-log/execution-log.service';
import { TradingSafetyService } from '../exchange/trading-safety.service';
import { PrismaService } from '../prisma/prisma.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const CREDS = { apiKey: 'test-key', apiSecret: 'test-secret' };
const USER_ID = 'test-user';

function makeAxiosError(status: number, data: any) {
  const err: any = new Error('Request failed');
  err.isAxiosError = true;
  err.response = { status, data };
  return err;
}

function makeMocks() {
  const precision = {
    get: jest.fn().mockResolvedValue({ baseIncrement: '1', quoteIncrement: '0.00001', minBaseQty: '1', minQuoteQty: '1' }),
    round: jest.fn((v: string) => v),
  } as unknown as PrecisionEngine;

  const execLog = {
    startOrder: jest.fn().mockResolvedValue({
      logId: 'log-1',
      resolve: jest.fn().mockResolvedValue(undefined),
      reject: jest.fn().mockResolvedValue(undefined),
    }),
  } as unknown as ExecutionLogService;

  const safety = { ensureEnabled: jest.fn(), validate: jest.fn().mockResolvedValue({ notional: '3.8', mid: '0.038' }) } as unknown as TradingSafetyService;
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue({ id: 'db-order' }),
      create: jest.fn().mockResolvedValue({ id: 'db-order' }),
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;

  return { precision, execLog, safety, prisma };
}

describe('MexcService', () => {
  let svc: MexcService;

  beforeEach(() => {
    const { precision, execLog, safety, prisma } = makeMocks();
    svc = new MexcService(precision, execLog, safety, prisma);
    jest.clearAllMocks();
  });

  describe('getTicker', () => {
    it('returns parsed ticker data', async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          symbol: 'ZIGUSDT',
          lastPrice: '0.038000',
          priceChange: '0.001',
          priceChangePercent: '2.7',
          highPrice: '0.040000',
          lowPrice: '0.036000',
          volume: '1000000',
          quoteVolume: '38000',
        },
      });

      const result = await svc.getTicker();
      expect(result.symbol).toBe('ZIGUSDT');
      expect(result.price).toBeCloseTo(0.038);
      expect(result.high).toBeCloseTo(0.04);
    });
  });

  describe('placeOrder', () => {
    beforeEach(() => {
      jest.spyOn(svc, 'getOrderBook').mockResolvedValue({ bids: [{ price: 0.037, qty: 1000 }], asks: [{ price: 0.039, qty: 1000 }] });
      jest.spyOn(svc, 'getBalances').mockResolvedValue([{ asset: 'ZIG', free: 1000, locked: 0 }, { asset: 'USDT', free: 1000, locked: 0 }]);
    });
    it('throws BadRequestException when LIMIT order has no price', async () => {
      await expect(svc.placeOrder(USER_ID, CREDS, 'BUY', 'LIMIT', '100'))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('posts to /api/v3/order with signed params', async () => {
      const mockCreate = jest.fn().mockReturnValue({
        post: jest.fn().mockResolvedValue({ data: { orderId: 'ord-1' } }),
      });
      mockedAxios.create = mockCreate;

      const result = await svc.placeOrder(USER_ID, CREDS, 'SELL', 'LIMIT', '100', '0.038');
      expect(result).toEqual({ orderId: 'ord-1' });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ headers: expect.objectContaining({ 'X-MEXC-APIKEY': 'test-key' }) }),
      );
    });

    it('extracts MEXC error message on API failure', async () => {
      const mockCreate = jest.fn().mockReturnValue({
        post: jest.fn().mockRejectedValue(makeAxiosError(400, { msg: 'Insufficient balance', code: -2010 })),
      });
      mockedAxios.create = mockCreate;
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);

      await expect(svc.placeOrder(USER_ID, CREDS, 'BUY', 'MARKET', '100'))
        .rejects.toMatchObject({ response: { status: 400 } });
    });
  });

  describe('getOrderBook', () => {
    it('parses bids and asks as numbers', async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          bids: [['0.038', '500'], ['0.037', '1000']],
          asks: [['0.039', '300']],
        },
      });

      const result = await svc.getOrderBook(2);
      expect(result.bids[0]).toEqual({ price: 0.038, qty: 500 });
      expect(result.asks[0]).toEqual({ price: 0.039, qty: 300 });
    });
  });

  describe('cancelOrder', () => {
    it('sends DELETE with orderId in signed params', async () => {
      const mockDelete = jest.fn().mockResolvedValue({ data: { status: 'CANCELED' } });
      const mockCreate = jest.fn().mockReturnValue({ delete: mockDelete });
      mockedAxios.create = mockCreate;

      const result = await svc.cancelOrder(USER_ID, CREDS, 'ord-123');
      expect(result).toEqual({ status: 'CANCELED' });
      const url: string = mockDelete.mock.calls[0][0];
      expect(url).toContain('orderId=ord-123');
    });
  });

  describe('validateCredentials', () => {
    it('returns true on successful account call', async () => {
      const mockGet = jest.fn().mockResolvedValue({ data: { balances: [] } });
      mockedAxios.create = jest.fn().mockReturnValue({ get: mockGet });

      expect(await svc.validateCredentials(CREDS)).toBe(true);
    });

    it('returns false on failed account call', async () => {
      mockedAxios.create = jest.fn().mockReturnValue({
        get: jest.fn().mockRejectedValue(makeAxiosError(401, { msg: 'Invalid API key' })),
      });

      expect(await svc.validateCredentials(CREDS)).toBe(false);
    });
  });
});
