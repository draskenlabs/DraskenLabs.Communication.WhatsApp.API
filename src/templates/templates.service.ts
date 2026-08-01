import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { Prisma, TemplateCategory, TemplateStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { BaseResponse } from 'src/common/responses/base-response';
import { normalizeRejectedReason } from 'src/common/utils/rejected-reason';
import { TemplateResponseDto, TemplateSyncResponseDto } from './dto/template.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';

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
  ) {}

  async syncTemplates(userId: number, ssoOrgId: string, wabaId: string): Promise<TemplateSyncResponseDto> {
    const userWhatsapp = await this.prisma.userWhatsapp.findFirst({
      where: { userId, wabaId },
    });
    if (!userWhatsapp) throw new NotFoundException('No connection found for this WABA');

    const waba = await this.prisma.waba.findFirst({ where: { wabaId, ssoOrgId } });
    if (!waba) throw new NotFoundException('WABA not found in your organisation');

    const accessToken = this.encryptionService.decrypt(userWhatsapp.accessToken);

    const response = await axios.get(
      `https://graph.facebook.com/${this.metaApiVersion}/${wabaId}/message_templates`,
      {
        params: { fields: 'id,name,language,status,category,components,rejected_reason', limit: 200 },
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    const templates: any[] = response.data?.data ?? [];
    let synced = 0;

    for (const t of templates) {
      try {
        await this.prisma.messageTemplate.upsert({
          where: { wabaId_name_language: { wabaId, name: t.name, language: t.language } },
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
        this.logger.warn(`Failed to upsert template ${t.name}/${t.language}: ${err.message}`);
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
    if (!userWhatsapp) throw new NotFoundException('No connection found for this WABA');

    const waba = await this.prisma.waba.findFirst({ where: { wabaId, ssoOrgId } });
    if (!waba) throw new NotFoundException('WABA not found in your organisation');

    const accessToken = this.encryptionService.decrypt(userWhatsapp.accessToken);

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
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
      );
      metaData = response.data;
    } catch (err: any) {
      const metaMessage = this.logMetaError(
        `Meta template create failed for ${dto.name} on WABA ${wabaId}`,
        err,
      );
      throw new BadRequestException(metaMessage || 'Failed to create template');
    }

    const template = await this.prisma.messageTemplate.upsert({
      where: { wabaId_name_language: { wabaId, name: dto.name, language: dto.language } },
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
      return BaseResponse.paginate(rows.map(this.toDto), total, totalPages, page, limit);
    }

    const rows = await this.prisma.messageTemplate.findMany({
      where,
      orderBy: { name: 'asc' },
    });
    return BaseResponse.success(rows.map(this.toDto));
  }

  async findOne(ssoOrgId: string, id: number): Promise<TemplateResponseDto> {
    const template = await this.prisma.messageTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Template not found');

    const waba = await this.prisma.waba.findFirst({ where: { wabaId: template.wabaId, ssoOrgId } });
    if (!waba) throw new NotFoundException('Template not found');

    return this.toDto(template);
  }

  async updateTemplate(
    userId: number,
    ssoOrgId: string,
    id: number,
    dto: UpdateTemplateDto,
  ): Promise<TemplateResponseDto> {
    const template = await this.prisma.messageTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Template not found');

    const { accessToken } = await this.resolveWabaContext(userId, ssoOrgId, template.wabaId);

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
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
      );
    } catch (err: any) {
      const metaMessage = this.logMetaError(
        `Meta template edit failed for ${template.name}`,
        err,
      );
      throw new BadRequestException(metaMessage || 'Failed to update template');
    }

    const updated = await this.prisma.messageTemplate.update({
      where: { id },
      data: {
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.components !== undefined && { components: dto.components as any }),
      },
    });

    return this.toDto(updated);
  }

  async deleteTemplate(userId: number, ssoOrgId: string, id: number): Promise<void> {
    const template = await this.prisma.messageTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Template not found');

    const { accessToken } = await this.resolveWabaContext(userId, ssoOrgId, template.wabaId);

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
    if (!userWhatsapp) throw new NotFoundException('No connection found for this WABA');

    const waba = await this.prisma.waba.findFirst({ where: { wabaId, ssoOrgId } });
    if (!waba) throw new NotFoundException('WABA not found in your organisation');

    return { wabaId, accessToken: this.encryptionService.decrypt(userWhatsapp.accessToken) };
  }

  private async resolveWabaIds(ssoOrgId: string, wabaId?: string): Promise<string[]> {
    if (wabaId) {
      // Verify the caller's org actually owns this WABA before scoping to it,
      // so a guessed wabaId can't read another organisation's templates.
      const waba = await this.prisma.waba.findFirst({ where: { wabaId, ssoOrgId } });
      if (!waba) throw new NotFoundException('WABA not found in your organisation');
      return [wabaId];
    }
    const wabas = await this.prisma.waba.findMany({ where: { ssoOrgId }, select: { wabaId: true } });
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
  private logMetaError(context: string, err: any): string {
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
