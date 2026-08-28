import { OrganisationSettingsService } from './organisation-settings.service';

/**
 * Stand-in for what we know about an organisation beyond the SSO's record.
 *
 * Defaults to "an ordinary organisation that pays for itself", which is what
 * almost every test is about: the agency case is the exception, and a test that
 * means it says so by overriding `get`.
 */
export function organisationSettingsDouble(): jest.Mocked<
  Pick<
    OrganisationSettingsService,
    | 'get'
    | 'billingOrgFor'
    | 'cacheVersionFor'
    | 'clientsOf'
    | 'clientRoster'
    | 'billingScope'
    | 'bumpPayerVersion'
  >
> {
  return {
    get: jest.fn((ssoOrgId: string) =>
      Promise.resolve({
        ssoOrgId,
        agencyOrgId: null,
        isAgency: false,
        clientName: null,
        payerVersion: 0,
      }),
    ),
    billingOrgFor: jest.fn((ssoOrgId: string) => Promise.resolve(ssoOrgId)),
    cacheVersionFor: jest.fn().mockResolvedValue(0),
    clientsOf: jest.fn().mockResolvedValue([]),
    clientRoster: jest.fn().mockResolvedValue([]),
    billingScope: jest.fn((ssoOrgId: string) => Promise.resolve([ssoOrgId])),
    bumpPayerVersion: jest.fn().mockResolvedValue(undefined),
  } as never;
}
