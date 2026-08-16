import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { MailService } from './mail.service';
import { MailNotifications } from './mail.notifications';
import { resolveSupportMailbox } from './support-mailbox';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  BroadcastDto,
  BroadcastResultDto,
  SupportRequestDto,
  SupportRequestResultDto,
  UnsubscribeDto,
  UnsubscribeResultDto,
} from './dto/mail.dto';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

/** The per-topic override, when a deployment wants one mailbox to differ. */
const TOPIC_MAILBOX: Record<string, string> = {
  support: 'SUPPORT_EMAIL',
  privacy: 'PRIVACY_EMAIL',
  security: 'SECURITY_EMAIL',
  abuse: 'ABUSE_EMAIL',
  legal: 'LEGAL_EMAIL',
};

@ApiTags('Mail')
@Controller('mail')
export class MailController {
  private readonly logger = new Logger(MailController.name);

  constructor(
    private readonly mail: MailService,
    private readonly notifications: MailNotifications,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Post('support')
  @ApiOperation({
    summary:
      'Send a message to our support, privacy, security or abuse mailbox',
    description:
      'Public: someone locked out of their account, or with no account at all, ' +
      'still has to be able to reach us. The sender gets an acknowledgement ' +
      'with the reply target stated on the support page.',
  })
  @ApiWrappedOkResponse({
    dataDto: SupportRequestResultDto,
    description: 'Whether the message was accepted',
  })
  @ApiStandardErrorResponses({ badRequest: true, validation: true })
  async support(
    @Req() req: Request,
    @Body() dto: SupportRequestDto,
  ): Promise<SupportRequestResultDto> {
    if (!this.mail.enabled) {
      throw new ServiceUnavailableException(
        'Email is not configured on this server. Write to us directly instead.',
      );
    }

    const topic = dto.topic ?? 'support';
    const mailbox = resolveSupportMailbox(topic, {
      base: this.config.get<string>('SUPPORT_EMAIL'),
      override: this.config.get<string>(TOPIC_MAILBOX[topic]),
      tagging: this.config.get<string>('SUPPORT_EMAIL_TAGGING') !== 'false',
    });
    if (!mailbox) {
      throw new BadRequestException(`No mailbox is configured for "${topic}".`);
    }

    // Signed-in senders are identified, which saves a round trip asking who
    // they are; anonymous ones are accepted too.
    const userId = (req as Request & { user?: { id: number } }).user?.id;

    const delivered = await this.notifications.supportRequest({
      to: mailbox,
      fromEmail: dto.email,
      fromName: dto.name,
      subject: dto.subject,
      message: dto.message,
      topic,
      userId,
    });

    // A failed send used to be answered with "we have your message", which is
    // the worst thing to tell someone whose message went nowhere. The retry
    // sweep will try again — it is kept and re-sent, not dropped — but the
    // sender is told plainly rather than reassured, and given the address to
    // write to if it matters now.
    if (!delivered) {
      this.logger.error(
        `Support request from ${dto.email} could not be delivered to ${mailbox}`,
      );
      throw new ServiceUnavailableException(
        `We could not deliver your message just now. We will keep trying, but ` +
          `if it is urgent please write to ${mailbox} directly.`,
      );
    }

    // Only once the message is actually with us: an acknowledgement for
    // something that never arrived is the same false promise in an email.
    await this.notifications.supportAcknowledgement(dto.email, dto.subject);

    return {
      received: true,
      message: 'We have your message and will reply within one business day.',
    };
  }

  @Post('unsubscribe')
  @ApiOperation({
    summary: 'Turn off one kind of email, or all of them',
    description:
      'Public and session-free: the link is signed, because people click ' +
      'these from a mail client on whichever device is to hand.',
  })
  @ApiWrappedOkResponse({
    dataDto: UnsubscribeResultDto,
    description: 'Whether the preference was changed',
  })
  @ApiStandardErrorResponses({ badRequest: true, validation: true })
  async unsubscribe(
    @Body() dto: UnsubscribeDto,
  ): Promise<UnsubscribeResultDto> {
    if (!this.mail.verifyUnsubscribe(dto.userId, dto.kind, dto.token)) {
      throw new BadRequestException('This unsubscribe link is not valid.');
    }
    await this.mail.applyUnsubscribe(dto.userId, dto.kind);
    return {
      ok: true,
      message:
        dto.kind === 'all'
          ? 'You will not receive any more email from us.'
          : 'You will not receive that kind of email again.',
    };
  }

  @Post('events')
  @ApiExcludeEndpoint()
  async sesEvents(
    @Headers('x-amz-sns-message-type') messageType: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    // SNS delivers bounces and complaints here. A bounce that is not recorded
    // means we keep mailing a dead address, which is what wrecks a sending
    // domain's reputation.
    try {
      const envelope = body as {
        Type?: string;
        Message?: string;
        SubscribeURL?: string;
      };

      if (
        messageType === 'SubscriptionConfirmation' ||
        envelope.Type === 'SubscriptionConfirmation'
      ) {
        // Confirmed manually in the AWS console — logging the URL is enough,
        // and auto-confirming would let anyone subscribe us to their topic.
        this.logger.warn(
          `SNS subscription confirmation received: ${envelope.SubscribeURL ?? 'no URL'}`,
        );
        return { ok: true };
      }

      const notification = JSON.parse(envelope.Message ?? '{}') as {
        notificationType?: string;
        eventType?: string;
        bounce?: {
          bounceType?: string;
          bouncedRecipients?: { emailAddress?: string }[];
        };
        complaint?: { complainedRecipients?: { emailAddress?: string }[] };
      };

      const type = notification.notificationType ?? notification.eventType;

      if (type === 'Bounce' && notification.bounce) {
        // Transient bounces (a full mailbox) resolve themselves; only a
        // permanent one means the address is gone.
        if (notification.bounce.bounceType === 'Permanent') {
          for (const recipient of notification.bounce.bouncedRecipients ?? []) {
            if (recipient.emailAddress) {
              await this.mail.suppress(
                recipient.emailAddress,
                'bounce',
                notification.bounce.bounceType,
              );
            }
          }
        }
      }

      if (type === 'Complaint' && notification.complaint) {
        for (const recipient of notification.complaint.complainedRecipients ??
          []) {
          if (recipient.emailAddress) {
            await this.mail.suppress(recipient.emailAddress, 'complaint');
          }
        }
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Could not process an SES feedback event: ${detail}`);
    }

    // Always 200: SNS retries anything else, and a malformed event is not
    // something a retry will fix.
    return { ok: true };
  }

  @Post('broadcast')
  @ApiExcludeEndpoint()
  async broadcast(
    @Headers('x-mail-admin-token') token: string | undefined,
    @Body() dto: BroadcastDto,
  ): Promise<BroadcastResultDto> {
    // Operator-only: policy changes, sub-processor notices and breach
    // notifications. Disabled unless a token is configured, so it cannot be
    // reached by default.
    const expected = this.config.get<string>('MAIL_ADMIN_TOKEN');
    if (!expected) {
      throw new ForbiddenException(
        'Broadcasts are not enabled on this server.',
      );
    }
    if (!token || token !== expected) {
      throw new ForbiddenException('Invalid admin token.');
    }

    const users = await this.prisma.user.findMany({
      where: { email: { not: null } },
      select: { id: true },
    });
    const recipients = await this.mail.recipientsByIds(users.map((u) => u.id));

    if (dto.dryRun) return { recipients: recipients.length, sent: 0 };

    const sent = await this.mail.sendToAll(recipients, {
      // Notices we are contractually obliged to give are transactional: a
      // policy change cannot be opted out of and still be a valid notice.
      kind: 'transactional',
      template: 'broadcast',
      subject: dto.subject,
      heading: dto.heading,
      intro: dto.intro,
      paragraphs: dto.paragraphs,
      action:
        dto.actionPath && dto.actionLabel
          ? { label: dto.actionLabel, path: dto.actionPath }
          : undefined,
      footnote:
        'You are receiving this because you hold a WhatsApp Console account. Notices about the service itself cannot be turned off.',
    });

    this.logger.log(`Broadcast "${dto.subject}" sent to ${sent} recipients`);
    return { recipients: recipients.length, sent };
  }
}
