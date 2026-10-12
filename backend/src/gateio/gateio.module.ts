import { Module } from '@nestjs/common';
import { GateioService } from './gateio.service';
import { GateioController } from './gateio.controller';
import { GateioGateway } from './gateio.gateway';
import { CredentialsModule } from '../credentials/credentials.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { ExecutionLogModule } from '../execution-log/execution-log.module';

@Module({
  imports: [CredentialsModule, ExchangeModule, ExecutionLogModule],
  providers: [GateioService, GateioGateway],
  controllers: [GateioController],
  exports: [GateioService],
})
export class GateioModule {}
