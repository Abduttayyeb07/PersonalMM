import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DeleteCredentialsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  accountPassword!: string;
}
