import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { UserWhatsappService } from 'src/user/user-whatsapp.service';
import { WabaService } from 'src/waba/waba.service';
import { WabaPhoneNumberService } from 'src/waba-phone-number/waba-phone-number.service';
import {
  ConnectWhatsAppRequestDTO,
  ConnectWhatsAppResponseDTO,
  ManualConnectRequestDTO,
} from './dto/connect-waba.dto';

@Injectable()
export class ConnectService {
  private readonly logger = new Logger(ConnectService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly userWhatsappService: UserWhatsappService,
    private readonly wabaService: WabaService,
    private readonly wabaPhoneNumberService: WabaPhoneNumberService,
  ) {}

  /**
   * DEV-ONLY: connect a WABA using a token supplied directly (no Embedded
   * Signup OAuth code). Intended for wiring up Meta's free test number, which
   * has no Embedded Signup flow. Disabled when NODE_ENV=production.
   */
  async manualConnect(
    body: ManualConnectRequestDTO,
    userId: number,
    ssoOrgId: string,
  ): Promise<ConnectWhatsAppResponseDTO> {
    const allowed =
      String(this.configService.get('ALLOW_MANUAL_CONNECT')).toLowerCase() === 'true';
    if (!allowed) {
      throw new ForbiddenException(
        'Manual connect is disabled. Set ALLOW_MANUAL_CONNECT=true to enable it.',
      );
    }

    const rawAccessToken = body.accessToken;

    // WABA metadata is best-effort — a test token may not read it.
    let wabaMeta: any = {};
    try {
      const wabaRes = await axios.get(
        `https://graph.facebook.com/v25.0/${body.wabaId}`,
        {
          params: {
            fields:
              'id,name,currency,timezone_id,message_template_namespace,owner_business_info',
          },
          headers: { Authorization: `Bearer ${rawAccessToken}` },
        },
      );
      wabaMeta = wabaRes.data;
    } catch (err: any) {
      this.logger.warn(
        `manualConnect: could not fetch WABA ${body.wabaId} metadata: ` +
          `${err?.response?.data?.error?.message ?? err?.message}`,
      );
    }

    const businessId: string =
      body.businessId ?? wabaMeta.owner_business_info?.id ?? 'manual';

    await this.wabaService.createOrUpdateWaba({
      wabaId: body.wabaId,
      userId,
      ssoOrgId,
      name: wabaMeta.name ?? body.name,
      currency: wabaMeta.currency,
      timezoneId: wabaMeta.timezone_id?.toString(),
      messageTemplateNamespace: wabaMeta.message_template_namespace,
    });

    const userWhatsapp = await this.userWhatsappService.createOrUpdate({
      userId,
      businessId,
      wabaId: body.wabaId,
      accessToken: rawAccessToken,
    });

    const phoneNumbers = await this.wabaPhoneNumberService.syncPhoneNumbersWithToken(
      userId,
      body.wabaId,
      rawAccessToken,
      userWhatsapp.accessToken,
    );

    await this.wabaService.subscribeAppToWaba(body.wabaId, rawAccessToken);

    return {
      wabaId: body.wabaId,
      businessId,
      phoneNumbers: phoneNumbers.map((p) => ({
        phoneNumberId: p.phoneNumberId,
        displayPhoneNumber: p.displayPhoneNumber,
        verifiedName: p.verifiedName,
      })),
    };
  }

  async connectWhatsapp(
    body: ConnectWhatsAppRequestDTO,
    userId: number,
    ssoOrgId: string,
  ): Promise<ConnectWhatsAppResponseDTO> {
    // 1. Exchange the Meta OAuth code for an access token
    const tokenRes = await axios.get(
      'https://graph.facebook.com/v25.0/oauth/access_token',
      {
        params: {
          client_id: this.configService.get('META_APP_ID') ?? '',
          client_secret: this.configService.get('META_APP_SECRET') ?? '',
          code: body.code,
        },
      },
    );
    const rawAccessToken: string = tokenRes.data.access_token;
    if (!rawAccessToken) throw new BadRequestException('Failed to exchange code for access token');

    // 2. Fetch WABA metadata from Meta (incl. owner business so we can derive
    //    the business id when the client didn't supply one).
    const wabaRes = await axios.get(
      `https://graph.facebook.com/v25.0/${body.wabaId}`,
      {
        params: {
          fields:
            'id,name,currency,timezone_id,message_template_namespace,owner_business_info',
        },
        headers: { Authorization: `Bearer ${rawAccessToken}` },
      },
    );
    const wabaMeta = wabaRes.data;

    const businessId: string | undefined = body.businessId ?? wabaMeta.owner_business_info?.id;
    if (!businessId) {
      throw new BadRequestException('Could not determine the Meta business id for this account');
    }

    // 3. Upsert Waba record with metadata
    await this.wabaService.createOrUpdateWaba({
      wabaId: body.wabaId,
      userId,
      ssoOrgId,
      name: wabaMeta.name,
      currency: wabaMeta.currency,
      timezoneId: wabaMeta.timezone_id?.toString(),
      messageTemplateNamespace: wabaMeta.message_template_namespace,
    });

    // 4. Store the connection — token is encrypted inside createOrUpdate
    const userWhatsapp = await this.userWhatsappService.createOrUpdate({
      userId,
      businessId,
      wabaId: body.wabaId,
      accessToken: rawAccessToken,
    });

    // 5. Sync phone numbers from Meta, populate Redis phone cache
    const phoneNumbers = await this.wabaPhoneNumberService.syncPhoneNumbersWithToken(
      userId,
      body.wabaId,
      rawAccessToken,
      userWhatsapp.accessToken, // already encrypted by createOrUpdate
    );

    // 6. Subscribe our app to the WABA's webhooks so delivery/read statuses and
    //    inbound messages actually arrive. Non-fatal — connecting still succeeds
    //    if the token lacks whatsapp_business_management (logged for diagnosis).
    await this.wabaService.subscribeAppToWaba(body.wabaId, rawAccessToken);

    return {
      wabaId: body.wabaId,
      businessId,
      phoneNumbers: phoneNumbers.map((p) => ({
        phoneNumberId: p.phoneNumberId,
        displayPhoneNumber: p.displayPhoneNumber,
        verifiedName: p.verifiedName,
      })),
    };
  }
}
