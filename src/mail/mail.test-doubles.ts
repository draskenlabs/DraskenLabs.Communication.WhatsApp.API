import { MailNotifications } from './mail.notifications';
import { MailService } from './mail.service';

/**
 * Stand-ins for the mail providers, so a unit test of a service that happens
 * to send an email does not have to know anything about SES.
 *
 * Every method resolves: email is fire-and-forget everywhere it is used, and a
 * test asserting on business logic should never fail because a notification
 * was not stubbed.
 */
export function mailNotificationsDouble(): jest.Mocked<
  Pick<
    MailNotifications,
    | 'accountDeleted'
    | 'apiKeyCreated'
    | 'apiKeyRevoked'
    | 'wabaConnected'
    | 'wabaDisconnected'
    | 'wabaDeleted'
    | 'metaTokenRejected'
    | 'wabaBanned'
    | 'templateDecision'
    | 'phoneQualityChanged'
    | 'displayNameDecision'
    | 'supportAcknowledgement'
    | 'supportRequest'
    | 'subscriptionCharged'
    | 'subscriptionPaymentFailed'
    | 'subscriptionCancelled'
  >
> {
  return {
    accountDeleted: jest.fn().mockResolvedValue(undefined),
    apiKeyCreated: jest.fn().mockResolvedValue(undefined),
    apiKeyRevoked: jest.fn().mockResolvedValue(undefined),
    wabaConnected: jest.fn().mockResolvedValue(undefined),
    wabaDisconnected: jest.fn().mockResolvedValue(undefined),
    wabaDeleted: jest.fn().mockResolvedValue(undefined),
    metaTokenRejected: jest.fn().mockResolvedValue(undefined),
    wabaBanned: jest.fn().mockResolvedValue(undefined),
    templateDecision: jest.fn().mockResolvedValue(undefined),
    phoneQualityChanged: jest.fn().mockResolvedValue(undefined),
    displayNameDecision: jest.fn().mockResolvedValue(undefined),
    supportAcknowledgement: jest.fn().mockResolvedValue(undefined),
    supportRequest: jest.fn().mockResolvedValue(undefined),
    subscriptionCharged: jest.fn().mockResolvedValue(undefined),
    subscriptionPaymentFailed: jest.fn().mockResolvedValue(undefined),
    subscriptionCancelled: jest.fn().mockResolvedValue(undefined),
  } as never;
}

export function mailServiceDouble(): jest.Mocked<
  Pick<MailService, 'recipientsForWaba' | 'recipientsByIds' | 'sendTo'>
> {
  return {
    recipientsForWaba: jest.fn().mockResolvedValue([]),
    recipientsByIds: jest.fn().mockResolvedValue([]),
    sendTo: jest.fn().mockResolvedValue(true),
  } as never;
}
