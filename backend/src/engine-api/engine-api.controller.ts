import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsNumber, IsNumberString, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { SimulationService } from './simulation.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthService } from '../auth/auth.service';
import { EngineApiService, EngineMode } from './engine-api.service';

class ModeQuery {
  @IsIn(['paper', 'live', 'backtest'])
  mode!: EngineMode;
}

class KillDto {
  @IsIn(['paper', 'live'])
  mode!: EngineMode;
}

class ResumeDto {
  @IsIn(['paper', 'live'])
  mode!: EngineMode;

  @IsString() @IsNotEmpty() @MaxLength(256)
  accountPassword!: string;
}

class SimSettingsDto {
  @IsNumberString() @MaxLength(20) startZig!: string;
  @IsNumberString() @MaxLength(20) startUsdt!: string;
  @IsNumberString() @MaxLength(20) rungSize!: string;
  @IsNumberString() @MaxLength(10) stepPct!: string;
  @IsIn([1, 2]) ladders!: 1 | 2;
  @ValidateIf((o) => o.basePrice !== null) @IsNumberString() @MaxLength(20) basePrice!: string | null;
  @IsNumberString() @MaxLength(20) floorPrice!: string;
  @IsNumberString() @MaxLength(20) topPrice!: string;
  @ValidateIf((o) => o.maxCycles !== null) @IsInt() @Min(1) @Max(1_000_000) maxCycles!: number | null;
  @ValidateIf((o) => o.maxHours !== null) @IsNumber() @Min(0.01) @Max(2160) maxHours!: number | null;
}

class SimStartDto {
  @ValidateNested() @Type(() => SimSettingsDto) settings!: SimSettingsDto;
}

/** The logged-in user's own engine. There is no way to address another user's engine here. */
@UseGuards(JwtAuthGuard)
@Controller('engine')
export class EngineApiController {
  constructor(
    private readonly engine: EngineApiService,
    private readonly auth: AuthService,
    private readonly simulation: SimulationService,
  ) {}

  // ── Paper simulation (the user's own; nothing reaches an exchange) ─────────────────────────

  @Get('simulation')
  simulationStatus(@Req() req: any) {
    return this.simulation.status(req.user.id);
  }

  @Post('simulation/preview')
  @HttpCode(200)
  simulationPreview(@Body() dto: SimStartDto) {
    return this.simulation.preview(dto.settings);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('simulation/start')
  @HttpCode(200)
  simulationStart(@Req() req: any, @Body() dto: SimStartDto) {
    return this.simulation.start(req.user.id, req.user.email, dto.settings);
  }

  @Get('simulation/audit')
  simulationAudit(@Req() req: any) {
    return this.simulation.audit(req.user.id);
  }

  @Post('simulation/stop')
  @HttpCode(200)
  simulationStop(@Req() req: any) {
    return this.simulation.stop(req.user.id, req.user.email);
  }

  @Get('overview')
  overview(@Req() req: any, @Query() q: ModeQuery) {
    return this.engine.overview(req.user.id, q.mode);
  }

  /** Any user can stop their own engine at once; stopping is always the safe direction. */
  @Post('kill')
  @HttpCode(200)
  async kill(@Req() req: any, @Body() dto: KillDto) {
    await this.engine.kill(req.user.id, dto.mode, req.user.email);
    return { ok: true };
  }

  /** Restarting trading needs the account password again. */
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('resume')
  @HttpCode(200)
  async resume(@Req() req: any, @Body() dto: ResumeDto) {
    await this.auth.verifyPassword(req.user.id, dto.accountPassword);
    await this.engine.resume(req.user.id, dto.mode, req.user.email);
    return { ok: true };
  }
}
