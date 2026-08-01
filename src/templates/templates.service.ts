import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { Prisma, TemplateCategory, TemplateStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import {
  isMetaAuthFailure,
  metaErrorMessage,
} from 'src/mail/meta-auth-failure';
import { EncryptionService } from 'src/common/services/crypto.service';
import { BaseResponse } from 'src/common/responses/base-response';
import { normalizeRejectedReason } from 'src/common/utils/rejected-reason';
import {
  TemplateResponseDto,
  TemplateStatusCountsDto,
  TemplateSyncResponseDto,
} from './dto/template.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import {
  CreateFromLibraryDto,
  LibraryTemplateDto,
  ListTemplateLibraryDto,
} from './dto/template-library.dto';
import {
  MigrateTemplatesDto,
  MigrateTemplatesResultDto,
} from './dto/template-migration.dto';

/** Options for {@link TemplatesService.findAll}. */
export interface FindTemplatesOptions {
  wabaId?: string;
  status?: string;
  category?: string;
  page?: number;
  limit?: number;
}

/** A resolved, authorised WABA connection with a decrypted Meta access token. */
interface WabaContext {
  wabaId: string;
  accessToken: string;
}

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);
  private readonly metaApiVersion = 'v21.0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly mail: MailNotifications,
  ) {}

  async syncTemplates(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
  ): Promise<TemplateSyncResponseDto> {
    const userWhatsapp = await this.prisma.userWhatsapp.findFirst({
      where: { userId, wabaId },
    });
    if (!userWhatsapp)
      throw new NotFoundException('No connection found for this WABA');

    const waba = await this.prisma.waba.findFirst({
      where: { wabaId, ssoOrgId },
    });
    if (!waba)
      throw new NotFoundException('WABA not found in your organisation');

    const accessToken = this.encryptionService.decrypt(
      userWhatsapp.accessToken,
    );

    const response = await axios.get(
      `https://graph.facebook.com/${this.metaApiVersion}/${wabaId}/message_templates`,
      {
        params: {
          fields: 'id,name,language,status,category,components,rejected_reason',
          limit: 200,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    const templates: any[] = response.data?.data ?? [];
    let synced = 0;

    for (const t of templates) {
      try {
        await this.prisma.messageTemplate.upsert({
          where: {
            wabaId_name_language: {
              wabaId,
              name: t.name,
              language: t.language,
            },
          },
          create: {
            metaTemplateId: String(t.id),
            wabaId,
            name: t.name,
            language: t.language,
            category: this.mapCategory(t.category),
            status: this.mapStatus(t.status),
            components: t.components ?? [],
            rejectedReason: normalizeRejectedReason(t.rejected_reason),
          },
          update: {
            metaTemplateId: String(t.id),
            category: this.mapCategory(t.category),
            status: this.mapStatus(t.status),
            components: t.components ?? [],
            rejectedReason: normalizeRejectedReason(t.rejected_reason),
          },
        });
        synced++;
      } catch (err: any) {
        this.logger.warn(
          `Failed to upsert template ${t.name}/${t.language}: ${err.message}`,
        );
      }
    }

    return { synced, wabaId };
  }

  async createTemplate(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
    dto: CreateTemplateDto,
  ): Promise<TemplateResponseDto> {
    const userWhatsapp = await this.prisma.userWhatsapp.findFirst({
      where: { userId, wabaId },
    });
    if (!userWhatsapp)
      throw new NotFoundException('No connection found for this WABA');

    const waba = await this.prisma.waba.findFirst({
      where: { wabaId, ssoOrgId },
    });
    if (!waba)
      throw new NotFoundException('WABA not found in your organisation');

    const accessToken = this.encryptionService.decrypt(
      userWhatsapp.accessToken,
    );

    const payload: Record<string, unknown> = {
      name: dto.name,
      category: dto.category,
      language: dto.language,
      components: dto.components,
    };
    if (dto.parameterFormat) payload.parameter_format = dto.parameterFormat;

    let metaData: { id: string | number; status?: string; category?: string };
    try {
      const response = await axios.post(
        `https://graph.facebook.com/${this.metaApiVersion}/${wabaId}/message_templates`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      metaData = response.data;
    } catch (err: any) {
      const metaMessage = this.logMetaError(
        `Meta template create failed for ${dto.name} on WABA ${wabaId}`,
        err,
        wabaId,
      );
      throw new BadRequestException(metaMessage || 'Failed to create template');
    }

    const template = await this.prisma.messageTemplate.upsert({
      where: {
        wabaId_name_language: {
          wabaId,
          name: dto.name,
          language: dto.language,
        },
      },
      create: {
        metaTemplateId: String(metaData.id),
        wabaId,
        name: dto.name,
        language: dto.language,
        category: this.mapCategory(metaData.category ?? dto.category),
        status: this.mapStatus(metaData.status ?? 'PENDING'),
        components: dto.components as any,
        rejectedReason: null,
      },
      update: {
        metaTemplateId: String(metaData.id),
        category: this.mapCategory(metaData.category ?? dto.category),
        status: this.mapStatus(metaData.status ?? 'PENDING'),
        components: dto.components as any,
        rejectedReason: null,
      },
    });

    return this.toDto(template);
  }

  /**
   * Browse Meta's Template Library — pre-written utility templates a business
   * can adopt instead of drafting one and waiting on review.
   *
   * The library is a global Meta catalogue rather than something we hold, so
   * this proxies straight through; the WABA is only here to resolve which
   * access token to call with, and to prove the caller owns it.
   */
  async listLibrary(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
    filters: ListTemplateLibraryDto,
  ): Promise<LibraryTemplateDto[]> {
    const { accessToken } = await this.resolveWabaContext(
      userId,
      ssoOrgId,
      wabaId,
    );

    const params: Record<string, string> = { limit: '100' };
    if (filters.search) params.search = filters.search;
    if (filters.topic) params.topic = filters.topic;
    if (filters.usecase) params.usecase = filters.usecase;
    if (filters.industry) params.industry = filters.industry;
    if (filters.language) params.language = filters.language;

    try {
      const response = await axios.get(
        `https://graph.facebook.com/${this.metaApiVersion}/message_template_library`,
        { params, headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const rows: unknown[] = Array.isArray(response.data?.data)
        ? response.data.data
        : [];
      return rows.map((row) => this.toLibraryDto(row));
    } catch (err: unknown) {
      const metaMessage = this.logMetaError(
        'Meta template library lookup failed',
        err,
      );
      throw new BadRequestException(
        metaMessage || 'Failed to load the template library',
      );
    }
  }

  /**
   * Adopt a library template into the caller's WABA.
   *
   * Meta copies the fixed content itself — we send the library name and only
   * the inputs it asks for (a phone number to call, a URL to open), never the
   * body, which cannot be edited. Library templates are always UTILITY.
   */
  async createFromLibrary(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
    dto: CreateFromLibraryDto,
  ): Promise<TemplateResponseDto> {
    const { accessToken } = await this.resolveWabaContext(
      userId,
      ssoOrgId,
      wabaId,
    );

    const payload: Record<string, unknown> = {
      name: dto.name,
      language: dto.language,
      category: 'UTILITY',
      library_template_name: dto.libraryTemplateName,
    };
    // Meta expects these as JSON-encoded strings on this endpoint, not objects.
    if (dto.libraryTemplateButtonInputs?.length) {
      payload.library_template_button_inputs = JSON.stringify(
        dto.libraryTemplateButtonInputs,
      );
    }
    if (
      dto.libraryTemplateBodyInputs &&
      Object.keys(dto.libraryTemplateBodyInputs).length > 0
    ) {
      payload.library_template_body_inputs = JSON.stringify(
        dto.libraryTemplateBodyInputs,
      );
    }

    let metaData: { id: string | number; status?: string; category?: string };
    try {
      const response = await axios.post(
        `https://graph.facebook.com/${this.metaApiVersion}/${wabaId}/message_templates`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      metaData = response.data;
    } catch (err: unknown) {
      const metaMessage = this.logMetaError(
        `Meta library template adoption failed for ${dto.libraryTemplateName} on WABA ${wabaId}`,
        err,
        wabaId,
      );
      throw new BadRequestException(
        metaMessage || 'Failed to create template from the library',
      );
    }

    const template = await this.prisma.messageTemplate.upsert({
      where: {
        wabaId_name_language: {
          wabaId,
          name: dto.name,
          language: dto.language,
        },
      },
      create: {
        metaTemplateId: String(metaData.id),
        wabaId,
        name: dto.name,
        language: dto.language,
        category: this.mapCategory(metaData.category ?? 'UTILITY'),
        status: this.mapStatus(metaData.status ?? 'PENDING'),
        // Meta owns the components for a library template; they arrive on the
        // next sync rather than being invented here.
        components: [],
        rejectedReason: null,
      },
      update: {
        metaTemplateId: String(metaData.id),
        category: this.mapCategory(metaData.category ?? 'UTILITY'),
        status: this.mapStatus(metaData.status ?? 'PENDING'),
        rejectedReason: null,
      },
    });

    return this.toDto(template);
  }

  /**
   * Copy approved templates from one WABA to another.
   *
   * Meta does the copying — this asks the destination WABA to pull from the
   * source, so the caller must own both. Only APPROVED templates with a GREEN
   * or UNKNOWN quality score are eligible; anything else comes back in
   * `failed_templates` with Meta's reason, which is passed through unchanged
   * rather than summarised, because the reason is the whole answer.
   *
   * The copies are then synced locally so they appear without waiting for a
   * webhook.
   */
  async migrateTemplates(
    userId: number,
    ssoOrgId: string,
    destinationWabaId: string,
    dto: MigrateTemplatesDto,
  ): Promise<MigrateTemplatesResultDto> {
    if (dto.sourceWabaId === destinationWabaId) {
      throw new BadRequestException(
        'Source and destination must be different WABAs',
      );
    }

    const { accessToken } = await this.resolveWabaContext(
      userId,
      ssoOrgId,
      destinationWabaId,
    );
    // Ownership of the source matters too — otherwise this would copy another
    // organisation's templates into the caller's account.
    await this.resolveWabaContext(userId, ssoOrgId, dto.sourceWabaId);

    const payload: Record<string, unknown> = {
      source_waba_id: dto.sourceWabaId,
    };
    if (dto.pageNumber !== undefined) payload.page_number = dto.pageNumber;
    if (dto.count !== undefined) payload.count = dto.count;
    if (dto.templateIds?.length) payload.template_ids = dto.templateIds;

    let data: Record<string, unknown>;
    try {
      const response = await axios.post(
        `https://graph.facebook.com/${this.metaApiVersion}/${destinationWabaId}/migrate_message_templates`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      data = (response.data ?? {}) as Record<string, unknown>;
    } catch (err: unknown) {
      const metaMessage = this.logMetaError(
        `Meta template migration failed from ${dto.sourceWabaId} to ${destinationWabaId}`,
        err,
        destinationWabaId,
      );
      throw new BadRequestException(
        metaMessage || 'Failed to migrate templates',
      );
    }

    const migratedTemplates = Array.isArray(data.migrated_templates)
      ? data.migrated_templates.map((id) => String(id))
      : [];
    const failedTemplates =
      typeof data.failed_templates === 'object' &&
      data.failed_templates !== null
        ? (data.failed_templates as Record<string, string>)
        : {};

    // Pull the copies in so the destination's list is right immediately; a
    // failure here must not make a successful migration look like it failed.
    if (migratedTemplates.length > 0) {
      try {
        await this.syncTemplates(userId, ssoOrgId, destinationWabaId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Migrated ${migratedTemplates.length} templates to ${destinationWabaId} but the follow-up sync failed: ${message}`,
        );
      }
    }

    return {
      migratedTemplates,
      failedTemplates,
      migratedCount: migratedTemplates.length,
      failedCount: Object.keys(failedTemplates).length,
    };
  }

  /** Maps one library row, tolerating fields Meta omits. */
  private toLibraryDto(row: unknown): LibraryTemplateDto {
    const r = (row ?? {}) as Record<string, unknown>;
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : undefined;

    return {
      id: String(r.id ?? ''),
      name: typeof r.name === 'string' ? r.name : '',
      language: typeof r.language === 'string' ? r.language : '',
      category: typeof r.category === 'string' ? r.category : 'UTILITY',
      topic: typeof r.topic === 'string' ? r.topic : undefined,
      usecase: typeof r.usecase === 'string' ? r.usecase : undefined,
      industry: strings(r.industry),
      header: typeof r.header === 'string' ? r.header : undefined,
      body: typeof r.body === 'string' ? r.body : '',
      bodyParams: strings(r.body_params),
      bodyParamTypes: strings(r.body_param_types),
      buttons: Array.isArray(r.buttons)
        ? (r.buttons as Record<string, unknown>[])
        : undefined,
    };
  }

  async findAll(
    ssoOrgId: string,
    opts: FindTemplatesOptions = {},
  ): Promise<BaseResponse<TemplateResponseDto[]>> {
    const wabaIds = await this.resolveWabaIds(ssoOrgId, opts.wabaId);

    const where: Prisma.MessageTemplateWhereInput = { wabaId: { in: wabaIds } };
    const status = this.parseEnum(TemplateStatus, opts.status);
    if (status) where.status = status;
    const category = this.parseEnum(TemplateCategory, opts.category);
    if (category) where.category = category;

    // Paginate only when the caller asks for it; otherwise return the full list
    // (keeps existing clients that render every template unaffected).
    if (opts.page !== undefined || opts.limit !== undefined) {
      const page = Math.max(1, opts.page ?? 1);
      const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
      const [rows, total] = await this.prisma.$transaction([
        this.prisma.messageTemplate.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.messageTemplate.count({ where }),
      ]);
      const totalPages = Math.ceil(total / limit);
      return BaseResponse.paginate(
        rows.map(this.toDto),
        total,
        totalPages,
        page,
        limit,
      );
    }

    const rows = await this.prisma.messageTemplate.findMany({
      where,
      orderBy: { name: 'asc' },
    });
    return BaseResponse.success(rows.map(this.toDto));
  }

  /**
   * Template counts per status for the organisation (optionally one WABA).
   * Deliberately ignores category and pagination: the console shows these
   * beside its status filter, so they must describe everything behind it.
   */
  async statusCounts(
    ssoOrgId: string,
    wabaId?: string,
  ): Promise<TemplateStatusCountsDto> {
    const wabaIds = await this.resolveWabaIds(ssoOrgId, wabaId);

    const grouped = await this.prisma.messageTemplate.groupBy({
      by: ['status'],
      where: { wabaId: { in: wabaIds } },
      _count: { _all: true },
    });

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of grouped) {
      byStatus[row.status] = row._count._all;
      total += row._count._all;
    }

    return { total, byStatus };
  }

  async findOne(ssoOrgId: string, id: number): Promise<TemplateResponseDto> {
    const template = await this.prisma.messageTemplate.findUnique({
      where: { id },
    });
    if (!template) throw new NotFoundException('Template not found');

    const waba = await this.prisma.waba.findFirst({
      where: { wabaId: template.wabaId, ssoOrgId },
    });
    if (!waba) throw new NotFoundException('Template not found');

    return this.toDto(template);
  }

  async updateTemplate(
    userId: number,
    ssoOrgId: string,
    id: number,
    dto: UpdateTemplateDto,
  ): Promise<TemplateResponseDto> {
    const template = await this.prisma.messageTemplate.findUnique({
      where: { id },
    });
    if (!template) throw new NotFoundException('Template not found');

    const { accessToken } = await this.resolveWabaContext(
      userId,
      ssoOrgId,
      template.wabaId,
    );

    const payload: Record<string, unknown> = {};
    if (dto.category !== undefined) payload.category = dto.category;
    if (dto.components !== undefined) payload.components = dto.components;
    if (Object.keys(payload).length === 0) {
      throw new BadRequestException('No changes provided');
    }

    try {
      // Meta edits target the template id (hsm_id), not the WABA collection.
      await axios.post(
        `https://graph.facebook.com/${this.metaApiVersion}/${template.metaTemplateId}`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
    } catch (err: any) {
      const metaMessage = this.logMetaError(
        `Meta template edit failed for ${template.name}`,
        err,
        template.wabaId,
      );
      throw new BadRequestException(metaMessage || 'Failed to update template');
    }

    const updated = await this.prisma.messageTemplate.update({
      where: { id },
      data: {
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.components !== undefined && {
          components: dto.components as any,
        }),
      },
    });

    return this.toDto(updated);
  }

  async deleteTemplate(
    userId: number,
    ssoOrgId: string,
    id: number,
  ): Promise<void> {
    const template = await this.prisma.messageTemplate.findUnique({
      where: { id },
    });
    if (!template) throw new NotFoundException('Template not found');

    const { accessToken } = await this.resolveWabaContext(
      userId,
      ssoOrgId,
      template.wabaId,
    );

    try {
      await axios.delete(
        `https://graph.facebook.com/${this.metaApiVersion}/${template.wabaId}/message_templates`,
        {
          // hsm_id targets this specific template; name is required by Meta.
          params: { hsm_id: template.metaTemplateId, name: template.name },
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
    } catch (err: any) {
      const metaMessage = this.logMetaError(
        `Meta template delete failed for ${template.name}`,
        err,
        template.wabaId,
      );
      throw new BadRequestException(metaMessage || 'Failed to delete template');
    }

    // Soft delete — keep the record for audit; Meta will also emit a webhook.
    await this.prisma.messageTemplate.update({
      where: { id },
      data: { status: TemplateStatus.DELETED },
    });
  }

  /**
   * Resolve and authorise a WABA connection for a user, returning a decrypted
   * Meta access token. Shared by create/update/delete.
   */
  private async resolveWabaContext(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
  ): Promise<WabaContext> {
    const userWhatsapp = await this.prisma.userWhatsapp.findFirst({
      where: { userId, wabaId },
    });
    if (!userWhatsapp)
      throw new NotFoundException('No connection found for this WABA');

    const waba = await this.prisma.waba.findFirst({
      where: { wabaId, ssoOrgId },
    });
    if (!waba)
      throw new NotFoundException('WABA not found in your organisation');

    return {
      wabaId,
      accessToken: this.encryptionService.decrypt(userWhatsapp.accessToken),
    };
  }

  private async resolveWabaIds(
    ssoOrgId: string,
    wabaId?: string,
  ): Promise<string[]> {
    if (wabaId) {
      // Verify the caller's org actually owns this WABA before scoping to it,
      // so a guessed wabaId can't read another organisation's templates.
      const waba = await this.prisma.waba.findFirst({
        where: { wabaId, ssoOrgId },
      });
      if (!waba)
        throw new NotFoundException('WABA not found in your organisation');
      return [wabaId];
    }
    const wabas = await this.prisma.waba.findMany({
      where: { ssoOrgId },
      select: { wabaId: true },
    });
    return wabas.map((w) => w.wabaId);
  }

  /** Return the value if it is a member of the enum, else undefined. */
  private parseEnum<T extends Record<string, string>>(
    enumObj: T,
    value?: string,
  ): T[keyof T] | undefined {
    if (!value) return undefined;
    return (Object.values(enumObj) as string[]).includes(value)
      ? (value as T[keyof T])
      : undefined;
  }

  private toDto(t: any): TemplateResponseDto {
    return {
      id: t.id,
      metaTemplateId: t.metaTemplateId,
      wabaId: t.wabaId,
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      components: t.components,
      rejectedReason: normalizeRejectedReason(t.rejectedReason) ?? undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  /**
   * Log the full Meta Graph API error and return the human-facing message.
   *
   * Meta permission failures (e.g. "does not have permission to create message
   * template") only differ by `code`/`error_subcode`; the `fbtrace_id` is what
   * Meta support needs to investigate. We surface the friendly message to the
   * caller but keep the diagnostic detail server-side.
   */
  /**
   * Log a Meta failure and, when it is our credentials that were rejected,
   * tell whoever owns the account — sending is down until they reconnect, and
   * a log line does not reach them.
   */
  private logMetaError(context: string, err: any, wabaId?: string): string {
    const metaError = err?.response?.data?.error;
    const userMessage =
      metaError?.error_user_msg ?? metaError?.message ?? err?.message;
    if (metaError) {
      this.logger.warn(
        `${context}: ${userMessage} ` +
          `[code=${metaError.code} subcode=${metaError.error_subcode} ` +
          `type=${metaError.type} fbtrace_id=${metaError.fbtrace_id}` +
          (metaError.error_data
            ? ` error_data=${JSON.stringify(metaError.error_data)}`
            : '') +
          ']',
      );
    } else {
      this.logger.warn(`${context}: ${userMessage}`);
    }
    if (wabaId && isMetaAuthFailure(err)) {
      void this.mail.metaTokenRejected(wabaId, metaErrorMessage(err));
    }

    return userMessage;
  }

  private mapStatus(raw: string): TemplateStatus {
    const map: Record<string, TemplateStatus> = {
      APPROVED: TemplateStatus.APPROVED,
      REJECTED: TemplateStatus.REJECTED,
      FLAGGED: TemplateStatus.FLAGGED,
      DELETED: TemplateStatus.DELETED,
      DISABLED: TemplateStatus.DISABLED,
      IN_APPEAL: TemplateStatus.IN_APPEAL,
    };
    return map[raw] ?? TemplateStatus.PENDING;
  }

  private mapCategory(raw: string): TemplateCategory {
    const map: Record<string, TemplateCategory> = {
      AUTHENTICATION: TemplateCategory.AUTHENTICATION,
      MARKETING: TemplateCategory.MARKETING,
      UTILITY: TemplateCategory.UTILITY,
    };
    return map[raw] ?? TemplateCategory.UTILITY;
  }
}
