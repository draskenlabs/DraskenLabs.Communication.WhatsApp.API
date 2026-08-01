import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateApiKeyDto {
  @ApiProperty({ description: 'Optional label for this API key' })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiProperty({
    description:
      'WABA this key may act on. It can send only from numbers belonging ' +
      'to that account, and reads only that account’s messages.',
    example: '220011334455',
  })
  @IsString()
  @IsNotEmpty()
  wabaId: string;
}

export class ApiKeyResponseDto {
  @ApiProperty()
  accessKey: string;

  @ApiProperty()
  secretKey: string;

  @ApiProperty({ description: 'WABA the key is scoped to' })
  wabaId: string;
}

export class ApiKeyListResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  accessKey: string;

  @ApiProperty({
    nullable: true,
    description:
      'WABA the key acts on. Null for keys issued before scoping existed — ' +
      'those no longer authenticate.',
  })
  wabaId: string | null;

  @ApiProperty({ nullable: true, description: 'Name of that WABA, for display' })
  wabaName: string | null;

  @ApiProperty()
  status: boolean;

  @ApiProperty()
  createdAt: Date;
}
