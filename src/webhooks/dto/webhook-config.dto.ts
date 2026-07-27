import { ApiProperty } from '@nestjs/swagger';

export class WebhookConfigDto {
  @ApiProperty({ description: 'Callback URL to register in the Meta App dashboard' })
  callbackUrl: string;

  @ApiProperty({ description: 'Whether the server is ready to receive events (verify token configured)' })
  subscribed: boolean;

  @ApiProperty({ description: 'HMAC signature header Meta sends on each delivery' })
  signatureHeader: string;

  @ApiProperty({ description: 'Webhook fields this server handles', type: [String] })
  fields: string[];

  @ApiProperty({ description: 'Whether WEBHOOK_VERIFY_TOKEN is configured (the value itself is never exposed)' })
  verifyTokenConfigured: boolean;
}
