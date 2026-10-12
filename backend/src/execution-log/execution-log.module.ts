import { Module } from '@nestjs/common';
import { ExecutionLogService } from './execution-log.service';
import { ExecutionLogController } from './execution-log.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  providers:   [ExecutionLogService],
  controllers: [ExecutionLogController],
  exports:     [ExecutionLogService],
})
export class ExecutionLogModule {}
