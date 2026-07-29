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
}
