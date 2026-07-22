import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

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
