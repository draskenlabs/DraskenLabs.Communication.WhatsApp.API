import { ApiProperty } from '@nestjs/swagger';

export class WabaPhoneNumberResponseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: '994909283715383' })
  phoneNumberId: string;

  @ApiProperty({ example: 'OneManPlay Games' })
  verifiedName: string;

  @ApiProperty({
    example: 'VERIFIED',
    description:
      "The number's own OTP registration with Meta — not its display name.",
  })
  codeVerificationStatus: string;

  @ApiProperty({
    example: 'APPROVED',
    nullable: true,
    description:
      'Where the display name stands with Meta: APPROVED, PENDING_REVIEW, ' +
      'DECLINED, EXPIRED, AVAILABLE_WITHOUT_REVIEW or NONE. Only an approved ' +
      'name is shown to recipients. Null until Meta has told us.',
  })
  nameStatus: string | null;

  @ApiProperty({ example: '+1 555-903-7297' })
  displayPhoneNumber: string;

  @ApiProperty({ example: 'UNKNOWN' })
  qualityRating: string;

  @ApiProperty({ example: 'NOT_APPLICABLE' })
  platformType: string;

  @ApiProperty({ example: 'NOT_APPLICABLE' })
  throughputLevel: string;

  @ApiProperty({
    example: '2026-04-23T20:15:20.000Z',
    nullable: true,
    description: 'Null until the number has completed onboarding.',
  })
  lastOnboardedTime: Date | null;

  @ApiProperty({ example: '1610143633542913' })
  wabaId: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
