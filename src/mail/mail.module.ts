import { Global, Module } from '@nestjs/common';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';
import { MailNotifications } from './mail.notifications';
import { MailScheduler } from './mail.scheduler';
import { SesService } from './ses.service';

/**
 * Outgoing email over Amazon SES.
 *
 * Global because almost every module has something worth telling a person
 * about — a key issued, a token rejected, a template decided — and threading
 * an import through each of them adds nothing.
 *
 * The support and unsubscribe routes are deliberately public: someone locked
 * out of their account, or unsubscribing from a mail client, has no session.
 */
@Global()
@Module({
  controllers: [MailController],
  providers: [SesService, MailService, MailNotifications, MailScheduler],
  exports: [MailService, MailNotifications],
})
export class MailModule {}
