import { ApiProperty } from '@nestjs/swagger';

export class UserProfileDto {
  @ApiProperty()
  id: number;

  @ApiProperty({ description: 'DraskenLabs SSO subject id' })
  ssoId: string;

  @ApiProperty({ description: 'Empty when the SSO session has expired' })
  firstName: string;

  @ApiProperty({ description: 'Empty when the SSO session has expired' })
  lastName: string;

  @ApiProperty({ description: 'Empty when the SSO session has expired' })
  email: string;

  @ApiProperty({ description: 'SSO username; empty when the user has not set one' })
  username: string;

  @ApiProperty({ description: 'Whether the SSO email address has been verified' })
  emailVerified: boolean;

  @ApiProperty({ description: 'Avatar URL from the SSO; empty when none is set' })
  imageUrl: string;

  @ApiProperty({ description: 'When the account was created in the SSO', nullable: true })
  createdAt: string | null;
}
