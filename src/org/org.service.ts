import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { PlanLimitsService } from 'src/plans/plan-limits.service';

@Injectable()
export class OrgService {
  private readonly apiBase: string;

  constructor(
    private readonly config: ConfigService,
    private readonly planLimits: PlanLimitsService,
  ) {
    this.apiBase = config.getOrThrow<string>('SSO_API_URL');
  }

  private headers(authorization: string) {
    return { Authorization: authorization };
  }

  private handleError(err: unknown): never {
    const error = err as AxiosError<{ message?: string }>;
    const msg = error.response?.data?.message ?? 'SSO request failed';
    const status = error.response?.status ?? 500;
    if (status === 401 || status === 403) throw new UnauthorizedException(msg);
    throw error;
  }

  async listOrgs(authorization: string) {
    try {
      const { data } = await axios.get(`${this.apiBase}/organizations`, {
        headers: this.headers(authorization),
      });
      return data.data ?? data;
    } catch (err) {
      this.handleError(err);
    }
  }

  async getOrg(orgId: string, authorization: string) {
    try {
      const { data } = await axios.get(
        `${this.apiBase}/organizations/${orgId}`,
        {
          headers: this.headers(authorization),
        },
      );
      return data.data ?? data;
    } catch (err) {
      this.handleError(err);
    }
  }

  async updateOrg(
    orgId: string,
    authorization: string,
    body: Record<string, unknown>,
  ) {
    try {
      const { data } = await axios.patch(
        `${this.apiBase}/organizations/${orgId}`,
        body,
        {
          headers: this.headers(authorization),
        },
      );
      return data.data ?? data;
    } catch (err) {
      this.handleError(err);
    }
  }

  async listMembers(orgId: string, authorization: string): Promise<unknown> {
    try {
      const { data } = await axios.get(
        `${this.apiBase}/organizations/${orgId}/members`,
        {
          headers: this.headers(authorization),
        },
      );
      return data.data ?? data;
    } catch (err) {
      this.handleError(err);
    }
  }

  /**
   * Invite somebody, if the plan has room for them.
   *
   * Membership lives in the SSO, so this is the one point the platform sees an
   * organisation grow — and therefore the only place "5 team members" can be
   * made true rather than printed. Counted against members *and* invitations
   * already out: an invitation somebody has not accepted yet is a seat spoken
   * for, and not counting it lets an organisation invite past its plan and
   * discover the limit only when people start accepting.
   */
  async inviteMember(
    orgId: string,
    authorization: string,
    body: Record<string, unknown>,
  ) {
    const limits = await this.planLimits.forOrg(orgId);
    if (limits.teamMembers !== null) {
      const [members, invitations] = await Promise.all([
        this.listMembers(orgId, authorization),
        this.listInvitations(orgId, authorization),
      ]);
      this.planLimits.assertWithin(
        limits,
        limits.teamMembers,
        (Array.isArray(members) ? members.length : 0) +
          (Array.isArray(invitations) ? invitations.length : 0),
        'team member',
      );
    }

    try {
      const { data } = await axios.post(
        `${this.apiBase}/organizations/${orgId}/members/invite`,
        body,
        {
          headers: this.headers(authorization),
        },
      );
      return data.data ?? data;
    } catch (err) {
      this.handleError(err);
    }
  }

  async updateMemberRole(
    orgId: string,
    userId: string,
    authorization: string,
    body: Record<string, unknown>,
  ) {
    try {
      const { data } = await axios.patch(
        `${this.apiBase}/organizations/${orgId}/members/${userId}/role`,
        body,
        {
          headers: this.headers(authorization),
        },
      );
      return data.data ?? data;
    } catch (err) {
      this.handleError(err);
    }
  }

  async removeMember(orgId: string, userId: string, authorization: string) {
    try {
      const { data } = await axios.delete(
        `${this.apiBase}/organizations/${orgId}/members/${userId}`,
        {
          headers: this.headers(authorization),
        },
      );
      return data.data ?? data;
    } catch (err) {
      this.handleError(err);
    }
  }

  async listInvitations(
    orgId: string,
    authorization: string,
  ): Promise<unknown> {
    try {
      const { data } = await axios.get(
        `${this.apiBase}/organizations/${orgId}/invitations`,
        {
          headers: this.headers(authorization),
        },
      );
      return data.data ?? data;
    } catch (err) {
      this.handleError(err);
    }
  }
}
