import { Module } from '@nestjs/common';
import { BybitService } from './bybit.service';
import { BybitController } from './bybit.controller';
import { BybitGateway } from './bybit.gateway';
import { CredentialsModule } from '../credentials/credentials.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { ExecutionLogModule } from '../execution-log/execution-log.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [CredentialsModule, ExchangeModule, ExecutionLogModule, AuthModule],
  providers: [BybitService, BybitGateway],
  controllers: [BybitController],
  exports: [BybitService],
})
export class BybitModule {}
