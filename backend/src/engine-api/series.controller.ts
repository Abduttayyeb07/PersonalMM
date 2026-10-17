import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsNumberString, IsOptional, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SeriesService } from './series.service';

class SeriesSettingsDto {
  @IsOptional() @IsIn(['SELL_FIRST', 'BUY_FIRST']) direction?: 'SELL_FIRST' | 'BUY_FIRST';
  @IsOptional() @IsBoolean() dailyReset?: boolean;
  @IsNumberString() @MaxLength(20) totalZig!: string;
  @IsNumberString() @MaxLength(20) startUsdt!: string;
  @ValidateIf((o) => o.basePrice !== null) @IsNumberString() @MaxLength(20) basePrice!: string | null;
  @IsNumberString() @MaxLength(10) sellPct!: string;
  @IsInt() @Min(1) @Max(50) orders!: number;
  @IsNumberString() @MaxLength(10) firstSellPct!: string;
  @IsNumberString() @MaxLength(10) stepPct!: string;
  @IsNumberString() @MaxLength(10) buybackPct!: string;
  @IsNumberString() @MaxLength(10) resellPct!: string;
  @ValidateIf((o) => o.maxCycles !== null) @IsInt() @Min(1) @Max(1_000_000) maxCycles!: number | null;
  @ValidateIf((o) => o.maxHours !== null) @IsNumber() @Min(0.01) @Max(2160) maxHours!: number | null;
}

class SeriesStartDto {
  @ValidateNested() @Type(() => SeriesSettingsDto) settings!: SeriesSettingsDto;
}

/** The logged-in user's own series. There is no way to address another user's series here. */
@UseGuards(JwtAuthGuard)
@Controller('series')
export class SeriesController {
  constructor(private readonly series: SeriesService) {}

  @Get()
  overview(@Req() req: any) {
    return this.series.overview(req.user.id);
  }

  @Post('preview')
  @HttpCode(200)
  preview(@Body() dto: SeriesStartDto) {
    return this.series.preview(dto.settings);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('start')
  @HttpCode(200)
  start(@Req() req: any, @Body() dto: SeriesStartDto) {
    return this.series.start(req.user.id, req.user.email, dto.settings);
  }

  /** Stopping is always allowed: every order of the series is cancelled. */
  @Post('stop')
  @HttpCode(200)
  stop(@Req() req: any) {
    return this.series.stop(req.user.id, req.user.email);
  }
}
