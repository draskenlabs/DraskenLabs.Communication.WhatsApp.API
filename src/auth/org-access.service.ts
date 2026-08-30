import { Injectable } from '@nestjs/common';
import {
  RedisService,
  SsoSessionData,
  OrgGrant,
} from 'src/redis/redis.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { OrgSummary, SsoService } from './sso.service';

/**
 * Who may act inside which organisation.
 *
 * This used to be settled once, at organisation selection, and stamped into a
 * JWT this API signed itself. It is not settled once any more: the credential
 * is the SSO's access token, which carries no organisation, so a request says
 * which organisation it means in `X-Org-Id` and this decides whether it may.
 *
 * A decision is cached on the session record, so the ordinary request costs the
 * one Redis read the user cache already cost. The uncached path is the first
 * request for an organisation after sign-in, or after the record has gone.
 */
@Injectable()
export class OrgAccessService {
  constructor(
    private readonly redis: RedisService,
    private readonly sso: SsoService,
    private readonly orgSettings: OrganisationSettingsService,
    private readonly orgDirectory: OrgDirectoryService,
  ) {}

  /**
   * The grant for `orgId` on this session, or `null` if there is none.
   *
   * `ssoAccessToken` is the live token from the request. It is used only to
   * rebuild membership when the session record is gone — an eviction, or a
   * deployment that started with a cold Redis — so a valid token is never
   * rejected because a cache is empty.
   */
  async grantFor(
    sid: string,
    orgId: string,
    ssoAccessToken: string,
  ): Promise<OrgGrant | null> {
    const session = await this.session(sid, ssoAccessToken);
    if (!session) return null;

    const cached = session.grants?.[orgId];
    if (cached) return cached;

    const grant = await this.resolve(session.orgs, orgId);
    if (!grant) return null;

    await this.record(sid, orgId, grant);
    return grant;
  }

  /** Writes a grant onto the session, so the next request reads it back. */
  async record(sid: string, orgId: string, grant: OrgGrant): Promise<void> {
    const session = await this.redis.getSsoSession(sid);
    if (!session) return;
    await this.redis.setSsoSession(sid, {
      ...session,
      grants: { ...(session.grants ?? {}), [orgId]: grant },
    });
  }

  /**
   * The organisations this session can enter, in switcher order: the ones the
   * SSO says they belong to, then the clients of any of those that is an
   * agency.
   *
   * Clients are appended on the way out and never stored as membership —
   * nobody at an agency is a member of a client in the SSO, and conflating the
   * two is how an agency would end up looking like a member to something that
   * checks membership.
   */
  async withClients(orgs: OrgSummary[]): Promise<OrgSummary[]> {
    const clients: OrgSummary[] = [];
    for (const org of orgs) {
      const settings = await this.orgSettings.get(org.id);
      if (!settings.isAgency) continue;
      for (const client of await this.orgSettings.clientRoster(org.id)) {
        clients.push({
          id: client.ssoOrgId,
          // The agency's own label first: a client whose people have never
          // logged in has no name anywhere else.
          name:
            client.clientName ??
            (await this.orgDirectory.name(client.ssoOrgId)) ??
            'Client',
          agencyOrgId: org.id,
        });
      }
    }
    return [...orgs, ...clients];
  }

  /**
   * Two ways in. Ordinarily that means membership in the SSO. An agency also
   * gets in to each of its clients, which are organisations here that never
   * grant anyone membership — that relationship is ours, so the SSO cannot
   * answer it and this does.
   */
  private async resolve(
    orgs: OrgSummary[],
    orgId: string,
  ): Promise<OrgGrant | null> {
    if (orgs.some((o) => o.id === orgId)) return { role: 'member' };

    const settings = await this.orgSettings.get(orgId);
    if (!settings.agencyOrgId) return null;
    const agency = orgs.find((o) => o.id === settings.agencyOrgId);
    if (!agency) return null;
    return { role: 'agency', agencyOrgId: agency.id };
  }

  /**
   * The session record, rebuilt from the SSO if it is missing.
   *
   * Membership is the SSO's answer, not ours, so a lost record costs one call
   * to get it back rather than a sign-in. What cannot be rebuilt — the profile
   * copied at login — is simply absent until the next sign-in refreshes it;
   * nothing on the request path reads it.
   */
  private async session(
    sid: string,
    ssoAccessToken: string,
  ): Promise<SsoSessionData | null> {
    const existing = await this.redis.getSsoSession(sid);
    if (existing) return existing;

    const orgs = await this.sso.listOrganizations(ssoAccessToken);
    const ssoId = this.sso.decodeUserInfo(ssoAccessToken).ssoId;
    const rebuilt: SsoSessionData = { ssoId, orgs, grants: {} };
    await this.redis.setSsoSession(sid, rebuilt);
    return rebuilt;
  }
}
