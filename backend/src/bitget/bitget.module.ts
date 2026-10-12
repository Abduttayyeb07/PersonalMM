import { Module } from '@nestjs/common';
import { BitgetService } from './bitget.service';
import { BitgetController } from './bitget.controller';
import { BitgetGateway } from './bitget.gateway';
import { CredentialsModule } from '../credentials/credentials.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { ExecutionLogModule } from '../execution-log/execution-log.module';

@Module({
  imports: [CredentialsModule, ExchangeModule, ExecutionLogModule],
  providers: [BitgetService, BitgetGateway],
  controllers: [BitgetController],
  exports: [BitgetService],
})
export class BitgetModule {}
