import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class PlaceOrderDto {
  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @IsIn(['MARKET', 'LIMIT'])
  type: 'MARKET' | 'LIMIT';

  @IsString()
  @Matches(/^\d+(\.\d+)?$/, { message: 'quantity must be a numeric string' })
  quantity: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d+)?$/, { message: 'price must be a numeric string' })
  price?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d+)?$/, { message: 'quoteOrderQty must be a numeric string' })
  quoteOrderQty?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9_-]+$/)
  idempotencyKey?: string;
}
