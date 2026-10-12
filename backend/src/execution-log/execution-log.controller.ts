import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ExecutionLogService } from './execution-log.service';

@UseGuards(JwtAuthGuard)
@Controller('execution-logs')
export class ExecutionLogController {
  constructor(private logs: ExecutionLogService) {}

  @Get()
  recent(@Request() req, @Query('limit') limit?: string) {
    return this.logs.getRecent(req.user.id, limit ? parseInt(limit) : 50);
  }
}
