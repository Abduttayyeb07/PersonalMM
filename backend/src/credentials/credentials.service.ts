import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../encryption/encryption.service';
import { AuthService } from '../auth/auth.service';
import { AlertService } from '../alert/alert.service';
import { SaveCredentialsDto } from './dto/save-credentials.dto';
import { CredentialLifecycleService } from './credential-lifecycle.service';

type Exchange = 'mexc' | 'bybit';
type RequestMeta = { ip?: string; userAgent?: string };
type PlainCredentials = { apiKey: string; apiSecret: string };

@Injectable()
export class CredentialsService {
  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
    private auth: AuthService,
    private config: ConfigService,
    private alert: AlertService,
    private lifecycle: CredentialLifecycleService,
  ) {}

  private aad(userId: string, exchange: string) {
    return `${userId}:${exchange}`;
  }

  private async audit(userId: string, exchange: string, action: string, meta: RequestMeta) {
    await this.prisma.credentialAudit.create({ data: {
      userId, exchange, action,
      ip: meta.ip?.slice(0, 128),
      userAgent: meta.userAgent?.slice(0, 512),
    } });
  }

  private async verifyMexc(creds: PlainCredentials) {
    const query = new URLSearchParams({ timestamp: Date.now().toString(), recvWindow: '10000' }).toString();
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(query).digest('hex');
    const { data } = await axios.get(`https://api.mexc.com/api/v3/account?${query}&signature=${signature}`, {
      timeout: 10_000,
      headers: { 'X-MEXC-APIKEY': creds.apiKey },
    });
    if (data?.canTrade !== true) {
      throw new BadRequestException('Invalid or unsafe API key: spot trading is disabled');
    }
  }

  private async verifyBybit(creds: PlainCredentials) {
    const timestamp = Date.now().toString();
    const recvWindow = '10000';
    const signature = crypto.createHmac('sha256', creds.apiSecret)
      .update(`${timestamp}${creds.apiKey}${recvWindow}`).digest('hex');
    const { data } = await axios.get('https://api.bybit.com/v5/user/query-api', {
      timeout: 10_000,
      headers: {
        'X-BAPI-API-KEY': creds.apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
    });
    if (data?.retCode !== 0) throw new Error('verification failed');
    const result = data.result ?? {};
    const wallet: string[] = result.permissions?.Wallet ?? [];
    if (wallet.some((permission) => permission.toLowerCase().includes('withdraw'))) {
      throw new BadRequestException('Invalid or unsafe API key: withdrawal permission is enabled');
    }
    if (result.readOnly === 1 || result.readOnly === true) {
      throw new BadRequestException('Invalid or unsafe API key: spot trading permission is required');
    }
    if (this.config.get('REQUIRE_IP_WHITELIST') !== 'false') {
      const ips: string[] = Array.isArray(result.ips) ? result.ips : [];
      if (!ips.length || ips.includes('*') || ips.includes('0.0.0.0/0')) {
        throw new BadRequestException('Invalid or unsafe API key: bind the key to this server IP');
      }
    }
  }

  private async verify(exchange: Exchange, creds: PlainCredentials) {
    try {
      if (exchange === 'bybit') await this.verifyBybit(creds);
      else await this.verifyMexc(creds);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Invalid or unsafe API key');
    }
  }

  async save(userId: string, dto: SaveCredentialsDto, meta: RequestMeta = {}) {
    await this.audit(userId, dto.exchange, 'SAVE', meta);
    await this.auth.verifyPassword(userId, dto.accountPassword);
    if (dto.exchange === 'mexc' && dto.safetyConfirmed !== true) {
      throw new BadRequestException('Confirm withdrawals are disabled and IP whitelisting is enabled');
    }
    await this.verify(dto.exchange, { apiKey: dto.apiKey, apiSecret: dto.apiSecret });
    const aad = this.aad(userId, dto.exchange);
    const data = {
      userId,
      exchange: dto.exchange,
      encryptedApiKey: this.encryption.encrypt(dto.apiKey, aad),
      encryptedApiSecret: this.encryption.encrypt(dto.apiSecret, aad),
      encryptedPassphrase: null,
      keyHint: `…${dto.apiKey.slice(-4)}`,
    };
    await this.prisma.exchangeCredential.upsert({
      where: { userId_exchange: { userId, exchange: dto.exchange } },
      update: data,
      create: data,
    });
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    await this.alert.send(`${dto.exchange.toUpperCase()} key connected for ${user?.email ?? userId}`);
    return { success: true, exchange: dto.exchange, keyHint: data.keyHint };
  }

  async withDecrypted<T>(userId: string, exchange: string, use: (credentials: PlainCredentials) => Promise<T>): Promise<T> {
    const cred = await this.prisma.exchangeCredential.findUnique({
      where: { userId_exchange: { userId, exchange } },
      select: { encryptedApiKey: true, encryptedApiSecret: true },
    });
    if (!cred) throw new NotFoundException(`No credentials for ${exchange}`);
    const aad = this.aad(userId, exchange);
    const credentials = {
      apiKey: this.encryption.decrypt(cred.encryptedApiKey, aad),
      apiSecret: this.encryption.decrypt(cred.encryptedApiSecret, aad),
    };
    return use(credentials);
  }

  /** Compatibility for legacy exchange modules. Never return this from an HTTP route. */
  async getDecrypted(userId: string, exchange: string) {
    return this.withDecrypted(userId, exchange, async (credentials) => ({ ...credentials, passphrase: null }));
  }

  async listConnected(userId: string) {
    return this.prisma.exchangeCredential.findMany({
      where: { userId, exchange: { in: ['mexc', 'bybit'] } },
      select: { exchange: true, keyHint: true, createdAt: true, updatedAt: true },
    });
  }

  async test(userId: string, exchange: Exchange, meta: RequestMeta = {}) {
    try {
      await this.withDecrypted(userId, exchange, (creds) => this.verify(exchange, creds));
      return { valid: true };
    } finally {
      await this.audit(userId, exchange, 'TEST', meta);
    }
  }

  async remove(userId: string, exchange: Exchange, password: string, meta: RequestMeta = {}) {
    await this.audit(userId, exchange, 'DELETE', meta);
    await this.auth.verifyPassword(userId, password);
    await this.lifecycle.disconnect(userId, exchange);
    const count = (await this.prisma.exchangeCredential.deleteMany({ where: { userId, exchange } })).count;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    await this.alert.send(`${exchange.toUpperCase()} key disconnected for ${user?.email ?? userId}`);
    return { success: true, deleted: count };
  }
}
