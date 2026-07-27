import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class RegisterPhoneNumberDto {
  @ApiProperty({
    description:
      'Six-digit registration PIN (the two-step verification code). If two-step verification is not yet enabled, this sets it.',
    example: '123456',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'pin must be a 6-digit number' })
  pin: string;
}
