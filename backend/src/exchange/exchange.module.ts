import { Module } from '@nestjs/common';
import { PrecisionEngine } from './precision.engine';
import { TradingSafetyService } from './trading-safety.service';

@Module({
  providers: [PrecisionEngine, TradingSafetyService],
  exports:   [PrecisionEngine, TradingSafetyService],
})
export class ExchangeModule {}
