import { SubscriptionAccessService } from './subscription-access.service';

/**
 * Stand-in for the paywall, so a unit test of sending or of templates does not
 * have to know that subscriptions exist.
 *
 * `requireAccess` resolves by default — the deployments most tests describe
 * have no payment provider configured, where it is a no-op anyway. A test that
 * cares makes it reject.
 */
export function billingServiceDouble(): jest.Mocked<
  Pick<SubscriptionAccessService, 'requireAccess' | 'hasAccess'>
> {
  return {
    requireAccess: jest.fn().mockResolvedValue(undefined),
    hasAccess: jest.fn().mockResolvedValue(true),
  } as never;
}
