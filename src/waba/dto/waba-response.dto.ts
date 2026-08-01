import { ApiProperty } from '@nestjs/swagger';

export class WabaResponseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: '1234567890' })
  wabaId: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'My WABA',
  })
  name?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'USD',
  })
  currency?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'America/New_York',
  })
  timezoneId?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'ns_123',
  })
  messageTemplateNamespace?: string | null;

  @ApiProperty({ example: '2026-04-23T21:18:54.420Z' })
  createdAt: Date;

  @ApiProperty({
    description:
      'Whether the caller still holds a Meta access token for this account. ' +
      'The record survives a disconnect for audit, so a listed WABA is not ' +
      'necessarily one we can act on — syncing or sending needs a connection.',
    example: true,
  })
  connected: boolean;
}

export class MetaWabaDetailsDto {
  @ApiProperty({ example: '1610143633542913' })
  id: string;

  @ApiProperty({ type: String, example: 'OneManPlay Games' })
  name: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: 'USD',
  })
  currency?: string | null;

  @ApiProperty({ type: String, example: '71' })
  timezone_id: string;

  @ApiProperty({
    type: String,
    example: '469e694b_b4a9_4163_958b_0de158f3e8d6',
  })
  message_template_namespace: string;

  @ApiProperty({ type: [String], example: ['MANAGE'] })
  tasks: string[];
}
