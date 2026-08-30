import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

export interface OrgSummary {
  id: string;
  name: string;
  slug?: string;
  /** Set only on a client organisation: the agency that manages it. */
  agencyOrgId?: string;
}

export interface SsoTokenData {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token is good for — 600 unless the client says otherwise. */
  expiresIn: number;
  tokenType?: string;
}

export interface SsoUserInfo {
  ssoId: string;
  email: string;
  firstName: string;
  lastName: string;
  ssoOrgId: string | null;
  role: string | null;
}

/**
 * The full profile from `GET /users/me`. The access token only carries `sub`
 * and `email`, so everything else here can be obtained no other way.
 */
export interface SsoProfile {
  ssoId: string;
  email: string;
  firstName: string;
  lastName: string;
  username: string;
  emailVerified: boolean;
  imageUrl: string;
  createdAt: string | null;
  updatedAt: string | null;
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
      const orgs = (data?.data ?? data) as
        | Array<Record<string, unknown>>
        | undefined;
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
   * Derives a short, friendly URL slug from an organisation name, e.g.
   * "Drasken Labs Private Limited" → "drasken-labs-private-limited".
   */
  private slugify(name: string): string {
    const slug = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '');
    return slug || 'organisation';
  }

  /**
   * Creates a new organisation in the SSO on behalf of the user (the user
   * becomes its owner). Sends a friendly slug derived from the name so orgs
   * don't get an auto-generated slug with a long unique suffix. Uses the user's
   * SSO access token; the created org is the single source of truth.
   */
  async createOrganization(
    ssoAccessToken: string,
    name: string,
  ): Promise<OrgSummary> {
    try {
      const { data } = await axios.post(
        `${this.apiBase}/organizations`,
        { name, slug: this.slugify(name) },
        { headers: { Authorization: `Bearer ${ssoAccessToken}` } },
      );
      const o = (data?.data ?? data) as Record<string, unknown> | undefined;
      if (!o || typeof o.id !== 'string') {
        throw new BadRequestException(
          'Malformed organisation response from SSO',
        );
      }
      return {
        id: o.id,
        name: (o.name as string) ?? name,
        slug: o.slug as string | undefined,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const error = err as AxiosError<{ message?: string }>;
      const msg =
        error.response?.data?.message ?? 'Failed to create organisation';
      const status = error.response?.status ?? 500;
      if (status === 401 || status === 403)
        throw new UnauthorizedException(msg);
      throw new BadRequestException(msg);
    }
  }

  /**
   * Fetches the user's profile from the SSO (`GET /users/me`).
   *
   * The SSO access token carries only `sub` and `email` — no name claims — so
   * without this call `firstName`/`lastName` decode to empty strings and the
   * console falls back to displaying the email address as the user's name.
   *
   * Best-effort by design: the caller (login) must still succeed when the SSO
   * profile endpoint is unavailable, falling back to the token claims.
   */
  async getProfile(ssoAccessToken: string): Promise<SsoProfile | null> {
    try {
      const { data } = await axios.get(`${this.apiBase}/users/me`, {
        headers: { Authorization: `Bearer ${ssoAccessToken}` },
      });
      const u = (data?.data ?? data) as Record<string, unknown> | undefined;
      if (!u || typeof u.id !== 'string') return null;
      return {
        ssoId: u.id,
        email: (u.email as string) ?? '',
        firstName: (u.firstName as string) ?? '',
        lastName: (u.lastName as string) ?? '',
        username: (u.username as string) ?? '',
        emailVerified: u.emailVerified === true,
        imageUrl: (u.imageUrl as string) ?? '',
        createdAt: (u.createdAt as string) ?? null,
        updatedAt: (u.updatedAt as string) ?? null,
      };
    } catch {
      return null;
    }
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<SsoTokenData> {
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

  /**
   * Trades a refresh token for a brand-new pair.
   *
   * The SSO rotates on every use: the token presented here is dead the moment
   * it is accepted, and presenting a spent one is treated as theft rather than
   * as a mistake — the whole session family is revoked. That is why the caller
   * ({@link AuthService.refresh}) serialises refreshes for a session and hands
   * a concurrent caller the pair the first one got, instead of letting two tabs
   * spend the same token and take the session down between them.
   *
   * Sent in the body, not as a cookie: this is a server-side caller, and the
   * cookie the SSO would set belongs to a browser talking to the SSO directly.
   */
  async refreshTokens(refreshToken: string): Promise<SsoTokenData> {
    try {
      const { data } = await axios.post(`${this.apiBase}/auth/refresh`, {
        refreshToken,
      });
      return data.data as SsoTokenData;
    } catch (err) {
      const error = err as AxiosError<{ message?: string }>;
      const msg =
        error.response?.data?.message ?? 'Could not refresh the session';
      throw new UnauthorizedException(msg);
    }
  }

  /**
   * Ends the session at the SSO, so signing out here signs out everywhere this
   * device was signed in.
   *
   * Best-effort by design: a sign-out that fails because the SSO is
   * unreachable must still clear this side. The alternative is a person who
   * cannot sign out of a console because a different service is down.
   */
  async logout(ssoAccessToken: string): Promise<void> {
    try {
      await axios.post(
        `${this.apiBase}/auth/logout`,
        {},
        { headers: { Authorization: `Bearer ${ssoAccessToken}` } },
      );
    } catch {
      // Nothing to do: the token expires on its own within minutes.
    }
  }

  decodeUserInfo(accessToken: string): SsoUserInfo {
    try {
      const [, payload] = accessToken.split('.');
      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf-8'),
      );

      const ssoId: string = decoded.sub;
      const email: string = decoded.email;
      const firstName: string =
        decoded.firstName ?? decoded.given_name ?? decoded.first_name ?? '';
      const lastName: string =
        decoded.lastName ?? decoded.family_name ?? decoded.last_name ?? '';

      if (!ssoId || !email) {
        throw new Error('Missing required claims in SSO token');
      }

      const ssoOrgId: string | null =
        decoded.orgId ??
        decoded.org_id ??
        decoded.activeOrgId ??
        decoded.active_org_id ??
        null;

      const role: string | null =
        decoded.role ?? decoded.orgRole ?? decoded.org_role ?? null;

      return { ssoId, email, firstName, lastName, ssoOrgId, role };
    } catch {
      throw new UnauthorizedException('Failed to decode SSO token');
    }
  }
}
