import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { validateEnvironment } from './config/validate-env';
import { CsrfGuard } from './common/csrf.guard';
import { UserThrottlerGuard } from './common/user-throttler.guard';
import { AlertModule } from './alert/alert.module';
import { PrismaModule } from './prisma/prisma.module';
import { EncryptionModule } from './encryption/encryption.module';
import { AuthModule } from './auth/auth.module';
import { CredentialsModule } from './credentials/credentials.module';
import { MexcModule } from './mexc/mexc.module';
import { BybitModule } from './bybit/bybit.module';
import { KucoinModule } from './kucoin/kucoin.module';
import { GateioModule } from './gateio/gateio.module';
import { BitgetModule } from './bitget/bitget.module';
import { ExchangeModule } from './exchange/exchange.module';
import { ExecutionLogModule } from './execution-log/execution-log.module';
import { EngineApiModule } from './engine-api/engine-api.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    ThrottlerModule.forRoot([
      // Generous global ceiling; sensitive routes (login, credentials, orders) tighten it with @Throttle.
      { name: 'default', ttl: 60_000, limit: 120 },
    ]),
    AlertModule,
    PrismaModule,
    EncryptionModule,
    AuthModule,
    CredentialsModule,
    ExchangeModule,
    ExecutionLogModule,
    MexcModule,
    BybitModule,
    KucoinModule,
    GateioModule,
    BitgetModule,
    EngineApiModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
export class AppModule {}
