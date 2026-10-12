import { Module } from '@nestjs/common';
import { MexcService } from './mexc.service';
import { MexcController } from './mexc.controller';
import { MexcGateway } from './mexc.gateway';
import { CredentialsModule } from '../credentials/credentials.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { ExecutionLogModule } from '../execution-log/execution-log.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [CredentialsModule, ExchangeModule, ExecutionLogModule, AuthModule],
  providers: [MexcService, MexcGateway],
  controllers: [MexcController],
  exports: [MexcService],
})
export class MexcModule {}
