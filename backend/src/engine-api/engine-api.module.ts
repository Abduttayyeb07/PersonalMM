import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EngineApiController } from './engine-api.controller';
import { EngineApiService } from './engine-api.service';
import { SimulationService } from './simulation.service';

@Module({
  imports: [AuthModule],
  providers: [EngineApiService, SimulationService],
  controllers: [EngineApiController],
})
export class EngineApiModule {}
