import { ExecutionContext, INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser = require('cookie-parser');
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CsrfGuard } from '../common/csrf.guard';
import { UserThrottlerGuard } from '../common/user-throttler.guard';

const body = { exchange: 'bybit', apiKey: 'key', apiSecret: 'secret', accountPassword: 'pw' };
const H = { 'X-Requested-With': 'zig' };
// Throttling is keyed on the JWT subject, so a fresh subject gets a fresh budget.
const asUser = (sub: string) => `access_token=x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.y`;

describe('credentials HTTP surface', () => {
  let app: INestApplication;
  const service = {
    save: jest.fn(),
    remove: jest.fn(),
    listConnected: jest.fn().mockResolvedValue([{ exchange: 'bybit', keyHint: '...1234' }]),
    test: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([
        { name: 'default', ttl: 60_000, limit: 120 },
      ])],
      controllers: [CredentialsController],
      providers: [
        { provide: CredentialsService, useValue: service },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: UserThrottlerGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: (ctx: ExecutionContext) => { ctx.switchToHttp().getRequest().user = { id: 'u1' }; return true; } })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => { service.save.mockReset(); service.remove.mockReset(); });

  it('rejects state-changing requests without the custom header', async () => {
    await request(app.getHttpServer()).post('/credentials').send(body).expect(401);
    expect(service.save).not.toHaveBeenCalled();
  });

  it('never serialises key material from GET /credentials', async () => {
    const res = await request(app.getHttpServer()).get('/credentials').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/apiKey|apiSecret|encrypted/i);
  });

  it('rejects an unknown exchange and unexpected fields', async () => {
    await request(app.getHttpServer()).post('/credentials').set(H).send({ ...body, exchange: 'kucoin' }).expect(400);
    await request(app.getHttpServer()).post('/credentials').set(H).send({ ...body, userId: 'someone-else' }).expect(400);
  });

  it('passes the wrong-password 401 through and answers the 6th attempt with 429', async () => {
    service.save.mockRejectedValue(new UnauthorizedException('Invalid account password'));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await request(app.getHttpServer()).post('/credentials').set(H).set('Cookie', asUser('rate-user')).send(body)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});
