import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { EngineApiController } from './engine-api.controller';
import { EngineApiService } from './engine-api.service';
import { SimulationService } from './simulation.service';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';

@Module({
  imports: [AuthModule, CredentialsModule],
  providers: [EngineApiService, SimulationService, SeriesService],
  controllers: [EngineApiController, SeriesController],
})
export class EngineApiModule {}
