import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

export interface OrgSummary {
  id: string;
  name: string;
  slug?: string;
}

interface SsoTokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SsoUserInfo {
  ssoId: string;
  email: string;
  firstName: string;
  lastName: string;
  ssoOrgId: string | null;
  role: string | null;
}

@Injectable()
export class SsoService {
  private readonly apiBase: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(private readonly config: ConfigService) {
    this.apiBase = config.getOrThrow<string>('SSO_API_URL');
    this.clientId = config.getOrThrow<string>('SSO_CLIENT_ID');
    this.clientSecret = config.getOrThrow<string>('SSO_CLIENT_SECRET');
    this.redirectUri = config.getOrThrow<string>('SSO_REDIRECT_URI');
  }

  /**
   * Exchanges a single-use authorization code for tokens (confidential client).
   *
   * The code is obtained by the browser redirect to DraskenLabs SSO
   * (`${SSO_ACCOUNTS_URL}/authorize`) and posted here by the web app together
   * with the original PKCE `codeVerifier`. This runs server-side so the client
   * secret never reaches the browser. The code is single-use and expires in 60s.
   */
  /**
   * Lists the user's organisations from the SSO.
   *
   * The DraskenLabs SSO access token does not embed an organisation claim, so
   * membership is fetched from `GET {SSO_API_URL}/organizations` using the
   * user's access token. Returns an empty array if they belong to none (or on
   * error — org resolution is best-effort at this layer).
   */
  async listOrganizations(ssoAccessToken: string): Promise<OrgSummary[]> {
    try {
      const { data } = await axios.get(`${this.apiBase}/organizations`, {
        headers: { Authorization: `Bearer ${ssoAccessToken}` },
      });
      const orgs = (data?.data ?? data) as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(orgs)) return [];
      return orgs
        .filter((o) => typeof o?.id === 'string')
        .map((o) => ({
          id: o.id as string,
          name: (o.name as string) ?? '',
          slug: o.slug as string | undefined,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Creates a new organisation in the SSO on behalf of the user (the user
   * becomes its owner). Uses the user's SSO access token; the created org is
   * the single source of truth, matching `listOrganizations`.
   */
  async createOrganization(ssoAccessToken: string, name: string): Promise<OrgSummary> {
    try {
      const { data } = await axios.post(
        `${this.apiBase}/organizations`,
        { name },
        { headers: { Authorization: `Bearer ${ssoAccessToken}` } },
      );
      const o = (data?.data ?? data) as Record<string, unknown> | undefined;
      if (!o || typeof o.id !== 'string') {
        throw new BadRequestException('Malformed organisation response from SSO');
      }
      return { id: o.id, name: (o.name as string) ?? name, slug: o.slug as string | undefined };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const error = err as AxiosError<{ message?: string }>;
      const msg = error.response?.data?.message ?? 'Failed to create organisation';
      const status = error.response?.status ?? 500;
      if (status === 401 || status === 403) throw new UnauthorizedException(msg);
      throw new BadRequestException(msg);
    }
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<SsoTokenData> {
    try {
      const { data } = await axios.post(`${this.apiBase}/auth/token`, {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        code,
        codeVerifier,
        redirectUri: this.redirectUri,
      });
      return data.data as SsoTokenData;
    } catch (err) {
      const error = err as AxiosError<{ message?: string }>;
      const msg = error.response?.data?.message ?? 'SSO token exchange failed';
      throw new UnauthorizedException(msg);
    }
  }

  decodeUserInfo(accessToken: string): SsoUserInfo {
    try {
      const [, payload] = accessToken.split('.');
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));

      const ssoId: string = decoded.sub;
      const email: string = decoded.email;
      const firstName: string = decoded.firstName ?? decoded.given_name ?? decoded.first_name ?? '';
      const lastName: string = decoded.lastName ?? decoded.family_name ?? decoded.last_name ?? '';

      if (!ssoId || !email) {
        throw new Error('Missing required claims in SSO token');
      }

      const ssoOrgId: string | null =
        decoded.orgId ?? decoded.org_id ?? decoded.activeOrgId ?? decoded.active_org_id ?? null;

      const role: string | null =
        decoded.role ?? decoded.orgRole ?? decoded.org_role ?? null;

      return { ssoId, email, firstName, lastName, ssoOrgId, role };
    } catch {
      throw new UnauthorizedException('Failed to decode SSO token');
    }
  }
}
