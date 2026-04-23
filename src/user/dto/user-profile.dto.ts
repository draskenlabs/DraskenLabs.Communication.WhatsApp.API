import { ApiProperty } from '@nestjs/swagger';

export class UserProfileDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  clerkId: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  status: boolean;

  @ApiProperty()
  createdAt: Date;
}
