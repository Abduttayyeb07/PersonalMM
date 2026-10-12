import { Module } from '@nestjs/common';
import { KucoinService } from './kucoin.service';
import { KucoinController } from './kucoin.controller';
import { KucoinGateway } from './kucoin.gateway';
import { CredentialsModule } from '../credentials/credentials.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { ExecutionLogModule } from '../execution-log/execution-log.module';

@Module({
  imports: [CredentialsModule, ExchangeModule, ExecutionLogModule],
  providers: [KucoinService, KucoinGateway],
  controllers: [KucoinController],
  exports: [KucoinService],
})
export class KucoinModule {}
