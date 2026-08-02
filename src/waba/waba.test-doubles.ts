import { WabaMembershipService } from './waba-membership.service';

/**
 * Stand-in for membership, so a unit test of templates or sending does not have
 * to build a `WabaOrganisation` fixture to say "yes, this org holds it".
 *
 * Permissive by default. A test that cares about the refusal makes `require`
 * reject or `holds` resolve false.
 */
export function wabaMembershipDouble(): jest.Mocked<
  Pick<WabaMembershipService, 'require' | 'holds' | 'connection'>
> {
  return {
    require: jest.fn().mockResolvedValue({ wabaId: 'w1', name: 'Test WABA' }),
    holds: jest.fn().mockResolvedValue(true),
    connection: jest
      .fn()
      .mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc_token' }),
  } as never;
}
