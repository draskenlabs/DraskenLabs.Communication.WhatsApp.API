import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { BaseResponse } from 'src/common/responses/base-response';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { assertSafeWebhookUrl } from './webhook-url.util';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
  WebhookDeliveryDto,
  WebhookEndpointDto,
  WebhookTestResultDto,
} from './dto/webhook-endpoint.dto';

/** The row shape the response mapper needs. */
interface EndpointRow {
  id: number;
  url: string;
  label: string | null;
  wabaId: string;
  events: string[];
  status: boolean;
  secret: string | null;
  failureCount: number;
  disabledAt: Date | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  waba?: { name: string | null } | null;
}

/**
 * The customer-facing half of webhooks: their endpoints, not Meta's.
 *
 * Every method takes the caller's organisation and checks the row against it.
 * An endpoint id is a small integer, so "find by id" without that check is a
 * way to read — and redirect — another organisation's event stream.
 */
@Injectable()
export class WebhookEndpointsService {
  private readonly allowInsecureUrls: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly dispatcher: WebhookDispatcherService,
    private readonly limits: PlanLimitsService,
  ) {
    this.allowInsecureUrls =
      String(
        this.config.get<string>('WEBHOOK_ALLOW_INSECURE_URLS') ?? 'false',
      ) === 'true';
  }

  async create(
    userId: number,
    ssoOrgId: string,
    dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointDto> {
    // The WABA is checked against the caller's organisation, not merely for
    // existence: an id from another org would otherwise wire that account's
    // events — customer replies included — to a URL of the caller's choosing.
    const waba = await this.prisma.waba.findFirst({
      where: { wabaId: dto.wabaId, WabaOrganisation: { some: { ssoOrgId } } },
      select: { wabaId: true, name: true },
    });
    if (!waba) {
      throw new NotFoundException(
        `WABA ${dto.wabaId} not found in this organisation`,
      );
    }

    const url = assertSafeWebhookUrl(dto.url, this.allowInsecureUrls);

    // How many endpoints this account may have is what its plan says — the
    // number is on the pricing page, so a constant here would contradict it.
    const [existing, limits] = await Promise.all([
      this.prisma.webhookEndpoint.count({
        where: { ssoOrgId, wabaId: waba.wabaId },
      }),
      this.limits.forWaba(ssoOrgId, waba.wabaId),
    ]);
    await this.limits.assertWithin(
      limits,
      limits.webhookEndpoints,
      existing,
      'webhook endpoint',
      'maxWebhookEndpoints',
    );

    const duplicate = await this.prisma.webhookEndpoint.findFirst({
      where: { ssoOrgId, wabaId: waba.wabaId, url },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(
        'That URL is already registered for this account. Edit the existing endpoint instead — two identical endpoints would double every delivery.',
      );
    }

    const created = await this.prisma.webhookEndpoint.create({
      data: {
        userId,
        ssoOrgId,
        wabaId: waba.wabaId,
        url,
        label: dto.label?.trim() || null,
        // Optional by design: an endpoint on a private network or behind its
        // own gateway auth does not need us to sign anything.
        secret: dto.secret ? this.encryption.encrypt(dto.secret) : null,
        events: dto.events ?? [],
      },
    });

    return this.toDto({ ...created, waba });
  }

  async findAll(
    ssoOrgId: string,
    wabaId?: string,
  ): Promise<WebhookEndpointDto[]> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { ssoOrgId, ...(wabaId ? { wabaId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { waba: { select: { name: true } } },
    });
    return endpoints.map((endpoint) => this.toDto(endpoint));
  }

  async update(
    ssoOrgId: string,
    id: number,
    dto: UpdateWebhookEndpointDto,
  ): Promise<WebhookEndpointDto> {
    const endpoint = await this.owned(ssoOrgId, id);

    const url =
      dto.url !== undefined
        ? assertSafeWebhookUrl(dto.url, this.allowInsecureUrls)
        : undefined;

    if (url && url !== endpoint.url) {
      const duplicate = await this.prisma.webhookEndpoint.findFirst({
        where: { ssoOrgId, wabaId: endpoint.wabaId, url, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) {
        throw new BadRequestException(
          'That URL is already registered for this account.',
        );
      }
    }

    // An empty string is how the console says "stop signing"; anything else
    // rotates the secret. Undefined leaves whatever is there alone.
    let secret: string | null | undefined;
    if (dto.secret !== undefined) {
      const trimmed = dto.secret.trim();
      if (trimmed === '') {
        secret = null;
      } else if (trimmed.length < 16) {
        throw new BadRequestException(
          'A signing secret must be at least 16 characters. Send an empty string to remove it.',
        );
      } else {
        secret = this.encryption.encrypt(trimmed);
      }
    }

    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(url !== undefined ? { url } : {}),
        ...(dto.label !== undefined ? { label: dto.label.trim() || null } : {}),
        ...(secret !== undefined ? { secret } : {}),
        ...(dto.events !== undefined ? { events: dto.events } : {}),
        ...(dto.status !== undefined
          ? {
              status: dto.status,
              // Turning one back on gives it a clean run: it was switched off
              // because it failed ten times, and starting at ten would disable
              // it again on the first failure after the fix.
              ...(dto.status ? { failureCount: 0, disabledAt: null } : {}),
            }
          : {}),
      },
      include: { waba: { select: { name: true } } },
    });

    return this.toDto(updated);
  }

  async remove(ssoOrgId: string, id: number): Promise<void> {
    await this.owned(ssoOrgId, id);
    // The delivery log goes with it (cascade): it is a log *of this endpoint*,
    // and keeping payloads for a URL nobody owns any more is not a feature.
    await this.prisma.webhookEndpoint.delete({ where: { id } });
  }

  /** Post a synthetic event and report what came back. */
  async test(ssoOrgId: string, id: number): Promise<WebhookTestResultDto> {
    const endpoint = await this.owned(ssoOrgId, id);
    if (!endpoint.status) {
      throw new BadRequestException(
        'This endpoint is disabled. Enable it before sending a test.',
      );
    }

    const { outcome, deliveryId } = await this.dispatcher.sendTest({
      id: endpoint.id,
      url: endpoint.url,
      secret: endpoint.secret,
      wabaId: endpoint.wabaId,
    });

    return {
      success: outcome.success,
      responseCode: outcome.responseCode,
      error: outcome.error,
      durationMs: outcome.durationMs,
      signed: !!endpoint.secret,
      deliveryId,
    };
  }

  async deliveries(
    ssoOrgId: string,
    id: number,
    opts: { page?: number; limit?: number } = {},
  ): Promise<BaseResponse<WebhookDeliveryDto[]>> {
    await this.owned(ssoOrgId, id);

    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const where = { endpointId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          eventType: true,
          status: true,
          attempts: true,
          responseCode: true,
          error: true,
          durationMs: true,
          retryAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);

    return BaseResponse.paginate(
      rows,
      total,
      Math.ceil(total / limit),
      page,
      limit,
    );
  }

  /**
   * Queue a delivery for another go, now.
   *
   * For the one that failed while the receiver was being fixed: the stored
   * payload is posted again unchanged, so the receiver sees the same bytes and
   * the same delivery id it can deduplicate on.
   */
  async redeliver(
    ssoOrgId: string,
    deliveryId: number,
  ): Promise<WebhookDeliveryDto> {
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpoint: { ssoOrgId } },
      select: {
        id: true,
        status: true,
        endpoint: { select: { status: true } },
      },
    });
    if (!delivery) throw new NotFoundException('Delivery not found');
    if (!delivery.endpoint.status) {
      throw new BadRequestException(
        'This endpoint is disabled. Enable it before redelivering.',
      );
    }
    if (delivery.status === 'pending' || delivery.status === 'failed') {
      throw new BadRequestException(
        'This delivery is already queued for another attempt.',
      );
    }

    const updated = await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'pending',
        // Attempts start over: this is a new decision by a person, not a
        // continuation of the run that gave up.
        attempts: 0,
        retryAt: new Date(),
        responseCode: null,
        error: null,
        durationMs: null,
      },
      select: {
        id: true,
        eventType: true,
        status: true,
        attempts: true,
        responseCode: true,
        error: true,
        durationMs: true,
        retryAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return updated;
  }

  /* ---------------------------------------------------------------- *
   * Internals                                                         *
   * ---------------------------------------------------------------- */

  /** The endpoint, if it belongs to this organisation. */
  private async owned(ssoOrgId: string, id: number) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    if (endpoint.ssoOrgId !== ssoOrgId) {
      throw new ForbiddenException(
        'Webhook endpoint does not belong to your organisation',
      );
    }
    return endpoint;
  }

  /** The row as the console sees it — never the secret, only that there is one. */
  private toDto(endpoint: EndpointRow): WebhookEndpointDto {
    return {
      id: endpoint.id,
      url: endpoint.url,
      label: endpoint.label,
      wabaId: endpoint.wabaId,
      wabaName: endpoint.waba?.name ?? null,
      events: endpoint.events,
      status: endpoint.status,
      hasSecret: !!endpoint.secret,
      failureCount: endpoint.failureCount,
      disabledAt: endpoint.disabledAt,
      lastSuccessAt: endpoint.lastSuccessAt,
      createdAt: endpoint.createdAt,
    };
  }
}
