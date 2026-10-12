import { IsBoolean, IsIn, IsNotEmpty, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export class SaveCredentialsDto {
  @IsIn(['mexc', 'bybit'])
  exchange!: 'mexc' | 'bybit';

  @IsString() @IsNotEmpty() @MaxLength(256) @Matches(/^\S+$/)
  apiKey!: string;

  @IsString() @IsNotEmpty() @MaxLength(256) @Matches(/^\S+$/)
  apiSecret!: string;

  @IsString() @IsNotEmpty() @MaxLength(256)
  accountPassword!: string;

  @ValidateIf((o: SaveCredentialsDto) => o.exchange === 'mexc')
  @IsBoolean()
  safetyConfirmed?: boolean;
}
