import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { CredentialsService } from './credentials.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeService() {
  const credential = {
    upsert: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([{ exchange: 'mexc', keyHint: '…1234', createdAt: new Date(), updatedAt: new Date() }]),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const audit = { create: jest.fn() };
  const prisma: any = {
    exchangeCredential: credential,
    credentialAudit: audit,
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'user@example.com' }) },
    $transaction: jest.fn(async (callback) => callback({ exchangeCredential: credential, credentialAudit: audit })),
  };
  const encryption: any = {
    encrypt: jest.fn((value, aad) => `v1:${aad}:${value}`),
    decrypt: jest.fn((value) => value.split(':').at(-1)),
  };
  const auth: any = { verifyPassword: jest.fn() };
  const config: any = { get: jest.fn((name) => name === 'REQUIRE_IP_WHITELIST' ? 'true' : undefined) };
  const alert: any = { send: jest.fn() };
  const lifecycle: any = { disconnect: jest.fn() };
  return { service: new CredentialsService(prisma, encryption, auth, config, alert, lifecycle), prisma, encryption };
}

describe('CredentialsService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only write-only connection metadata', async () => {
    const { service, prisma } = makeService();
    const result = await service.listConnected('user-a');
    expect(JSON.stringify(result)).not.toMatch(/apiKey|apiSecret|encrypted/i);
    expect(prisma.exchangeCredential.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: { exchange: true, keyHint: true, createdAt: true, updatedAt: true },
    }));
  });

  it('rejects a Bybit key with withdrawal permission without persisting it', async () => {
    mockedAxios.get.mockResolvedValue({ data: { retCode: 0, result: { readOnly: 0, ips: ['203.0.113.10'], permissions: { Wallet: ['Withdraw'] } } } });
    const { service, prisma } = makeService();
    await expect(service.save('user-a', {
      exchange: 'bybit', apiKey: 'key1234', apiSecret: 'secret', accountPassword: 'password',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.exchangeCredential.upsert).not.toHaveBeenCalled();
  });

  it('binds encrypted values to user and exchange and stores only a hint', async () => {
    mockedAxios.get.mockResolvedValue({ data: { canTrade: true } });
    const { service, encryption, prisma } = makeService();
    await service.save('user-a', {
      exchange: 'mexc', apiKey: 'abc1234', apiSecret: 'secret', accountPassword: 'password', safetyConfirmed: true,
    });
    expect(encryption.encrypt).toHaveBeenCalledWith('abc1234', 'user-a:mexc');
    expect(encryption.encrypt).toHaveBeenCalledWith('secret', 'user-a:mexc');
    expect(prisma.exchangeCredential.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ keyHint: '…1234' }),
    }));
  });
});
