import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { TemplateCategory, TemplateStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { TemplateResponseDto, TemplateSyncResponseDto } from './dto/template.dto';
import { CreateTemplateDto } from './dto/create-template.dto';

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
            rejectedReason: t.rejected_reason ?? null,
          },
          update: {
            metaTemplateId: String(t.id),
            category: this.mapCategory(t.category),
            status: this.mapStatus(t.status),
            components: t.components ?? [],
            rejectedReason: t.rejected_reason ?? null,
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
      const metaMessage =
        err.response?.data?.error?.error_user_msg ??
        err.response?.data?.error?.message ??
        err.message;
      this.logger.warn(`Meta template create failed for ${dto.name}: ${metaMessage}`);
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

  async findAll(ssoOrgId: string, wabaId?: string): Promise<TemplateResponseDto[]> {
    const wabaIds = await this.resolveWabaIds(ssoOrgId, wabaId);

    const templates = await this.prisma.messageTemplate.findMany({
      where: { wabaId: { in: wabaIds } },
      orderBy: { name: 'asc' },
    });

    return templates.map(this.toDto);
  }

  async findOne(ssoOrgId: string, id: number): Promise<TemplateResponseDto> {
    const template = await this.prisma.messageTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Template not found');

    const waba = await this.prisma.waba.findFirst({ where: { wabaId: template.wabaId, ssoOrgId } });
    if (!waba) throw new NotFoundException('Template not found');

    return this.toDto(template);
  }

  private async resolveWabaIds(ssoOrgId: string, wabaId?: string): Promise<string[]> {
    if (wabaId) return [wabaId];
    const wabas = await this.prisma.waba.findMany({ where: { ssoOrgId }, select: { wabaId: true } });
    return wabas.map((w) => w.wabaId);
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
      rejectedReason: t.rejectedReason ?? undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
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
