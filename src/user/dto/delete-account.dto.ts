import { ApiProperty } from '@nestjs/swagger';

/**
 * What a `DELETE /user/account` call removed. Returned so the client can tell
 * the user exactly what went, and so the deletion is auditable from the logs.
 */
export class DeleteAccountResultDto {
  @ApiProperty({ description: 'WhatsApp Business Accounts disconnected from this platform' })
  wabas: number;

  @ApiProperty({ description: 'Phone numbers removed with those WABAs' })
  phoneNumbers: number;

  @ApiProperty({ description: 'Message templates removed with those WABAs' })
  templates: number;

  @ApiProperty({ description: 'Sent messages and their delivery status' })
  messages: number;

  @ApiProperty({ description: 'Inbound messages received on those WABAs' })
  inboundMessages: number;

  @ApiProperty({ description: 'API keys revoked and deleted' })
  apiKeys: number;

  @ApiProperty({ description: 'Meta access tokens destroyed' })
  metaConnections: number;

  @ApiProperty({
    description:
      'Contacts deleted. Only removed for organisations left with no other user of this platform, so a colleague’s contact list is never wiped',
  })
  contacts: number;

  @ApiProperty({ description: 'Stored webhook events for those WABAs' })
  webhookEvents: number;
}
