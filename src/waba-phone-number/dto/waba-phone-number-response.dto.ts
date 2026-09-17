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
      'Where the display name in use stands with Meta: APPROVED, ' +
      'AVAILABLE_WITHOUT_REVIEW (cleared with no manual review), ' +
      'PENDING_REVIEW, DECLINED, EXPIRED, or NONE/NON_EXISTS where Meta has ' +
      'no review on file. Only an approved name is shown to recipients. ' +
      'Independent of codeVerificationStatus — neither waits on the other. ' +
      'Null until Meta has told us.',
  })
  nameStatus: string | null;

  @ApiProperty({
    example: 'Drasken Labs Support',
    nullable: true,
    description:
      'A rename that has been requested but not yet approved. The approved ' +
      'name stays in verifiedName and in use until this one clears review. ' +
      'Null when no rename is pending.',
  })
  newDisplayName: string | null;

  @ApiProperty({
    example: 'PENDING_REVIEW',
    nullable: true,
    description:
      "Where the requested rename stands, in the same vocabulary as " +
      'nameStatus. Null when no rename is pending.',
  })
  newNameStatus: string | null;

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
