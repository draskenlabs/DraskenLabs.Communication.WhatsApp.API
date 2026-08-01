import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  SEARCH_TYPES,
  SearchGroupDto,
  SearchResponseDto,
  SearchResultDto,
  SearchType,
} from './dto/search.dto';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

/**
 * Order the groups come back in. Contacts and messages are what someone is
 * usually reaching for; accounts and numbers are looked up far less often, so
 * they sit at the bottom rather than pushing a name off the visible list.
 */
const TYPE_ORDER: SearchType[] = [
  'contact',
  'message',
  'template',
  'phoneNumber',
  'waba',
];

/** Case-insensitive substring match, written once. */
const like = (q: string): Prisma.StringFilter => ({
  contains: q,
  mode: 'insensitive',
});

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One query against everything the console can link to.
   *
   * Each type is counted as well as listed, so the overlay can say "5 of 37"
   * instead of implying the five it shows are all there is.
   */
  async search(
    ssoOrgId: string,
    rawQuery: string,
    options: { limit?: number; types?: string[] } = {},
  ): Promise<SearchResponseDto> {
    const q = (rawQuery ?? '').trim();
    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const wanted = this.resolveTypes(options.types);

    // A single character matches almost everything, which is not a search so
    // much as a table scan with a heading.
    if (q.length < 2) return { query: q, total: 0, groups: [] };

    const wabaIds = await this.orgWabaIds(ssoOrgId);

    const groups = await Promise.all(
      TYPE_ORDER.filter((t) => wanted.has(t)).map((type) =>
        this.searchOne(type, { ssoOrgId, q, limit, wabaIds }),
      ),
    );

    const found = groups.filter((g) => g.total > 0);
    return {
      query: q,
      total: found.reduce((sum, g) => sum + g.total, 0),
      groups: found,
    };
  }

  /* ---------------------------------------------------------------- *
   * Per-type searches                                                 *
   * ---------------------------------------------------------------- */

  private searchOne(type: SearchType, scope: Scope): Promise<SearchGroupDto> {
    switch (type) {
      case 'contact':
        return this.contacts(scope);
      case 'message':
        return this.messages(scope);
      case 'template':
        return this.templates(scope);
      case 'phoneNumber':
        return this.phoneNumbers(scope);
      case 'waba':
        return this.wabas(scope);
    }
  }

  /** Name, phone or email. */
  private async contacts({
    ssoOrgId,
    q,
    limit,
  }: Scope): Promise<SearchGroupDto> {
    const where: Prisma.ContactWhereInput = {
      ssoOrgId,
      OR: [
        { name: like(q) },
        { email: like(q) },
        ...this.phoneClauses(q).map((phone) => ({ phone })),
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
      }),
      this.prisma.contact.count({ where }),
    ]);

    return {
      type: 'contact',
      total,
      items: rows.map((c) => ({
        type: 'contact' as const,
        id: String(c.id),
        title: c.name ?? c.phone,
        subtitle: c.name ? c.phone : undefined,
        description: c.email ?? undefined,
        badge: c.optedOut ? 'Opted out' : undefined,
        timestamp: c.createdAt,
      })),
    };
  }

  /** Recipient, Meta message ID, or the template that was sent. */
  private async messages({
    ssoOrgId,
    q,
    limit,
  }: Scope): Promise<SearchGroupDto> {
    const where: Prisma.MessageWhereInput = {
      ssoOrgId,
      OR: [
        { metaMessageId: like(q) },
        { templateName: like(q) },
        ...this.phoneClauses(q).map((to) => ({ to })),
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.message.count({ where }),
    ]);

    return {
      type: 'message',
      total,
      items: rows.map((m) => ({
        type: 'message' as const,
        id: String(m.id),
        title: m.to,
        // A template send says which template, since "template" on its own
        // tells the reader nothing they did not already know.
        subtitle: m.templateName ?? m.type,
        description: m.metaMessageId ?? undefined,
        badge: m.status,
        timestamp: m.createdAt,
      })),
    };
  }

  /** Template name, scoped to the organisation's accounts. */
  private async templates({
    q,
    limit,
    wabaIds,
  }: Scope): Promise<SearchGroupDto> {
    const where: Prisma.MessageTemplateWhereInput = {
      wabaId: { in: wabaIds },
      name: like(q),
    };

    const [rows, total] = await Promise.all([
      this.prisma.messageTemplate.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
      }),
      this.prisma.messageTemplate.count({ where }),
    ]);

    return {
      type: 'template',
      total,
      items: rows.map((t) => ({
        type: 'template' as const,
        id: String(t.id),
        title: t.name,
        subtitle: `${t.category} · ${t.language}`,
        badge: t.status,
        timestamp: t.updatedAt,
      })),
    };
  }

  /** Display name, the number itself, or its Meta ID. */
  private async phoneNumbers({
    q,
    limit,
    wabaIds,
  }: Scope): Promise<SearchGroupDto> {
    const where: Prisma.WabaPhoneNumberWhereInput = {
      wabaId: { in: wabaIds },
      OR: [
        { verifiedName: like(q) },
        { phoneNumberId: like(q) },
        ...this.phoneClauses(q).map((displayPhoneNumber) => ({
          displayPhoneNumber,
        })),
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.wabaPhoneNumber.findMany({ where, take: limit }),
      this.prisma.wabaPhoneNumber.count({ where }),
    ]);

    return {
      type: 'phoneNumber',
      total,
      items: rows.map((p) => ({
        type: 'phoneNumber' as const,
        id: p.phoneNumberId,
        title: p.verifiedName,
        subtitle: p.displayPhoneNumber,
        badge: p.qualityRating,
      })),
    };
  }

  /** Account name or WABA ID. */
  private async wabas({ ssoOrgId, q, limit }: Scope): Promise<SearchGroupDto> {
    const where: Prisma.WabaWhereInput = {
      ssoOrgId,
      OR: [{ name: like(q) }, { wabaId: like(q) }],
    };

    const [rows, total] = await Promise.all([
      this.prisma.waba.findMany({ where, take: limit }),
      this.prisma.waba.count({ where }),
    ]);

    return {
      type: 'waba',
      total,
      items: rows.map((w) => ({
        type: 'waba' as const,
        id: w.wabaId,
        title: w.name ?? w.wabaId,
        subtitle: w.name ? w.wabaId : undefined,
      })),
    };
  }

  /* ---------------------------------------------------------------- *
   * Helpers                                                           *
   * ---------------------------------------------------------------- */

  /**
   * Phone columns hold digits only, so "+44 7911 123456" would match nothing
   * as typed. Both forms are tried: the digits for a phone-shaped query, and
   * the raw text for anything else.
   */
  private phoneClauses(q: string): Prisma.StringFilter[] {
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 2 && digits !== q) return [like(digits), like(q)];
    return [like(q)];
  }

  /** Which types to search — everything, unless asked to narrow. */
  private resolveTypes(types?: string[]): Set<SearchType> {
    const asked = (types ?? [])
      .flatMap((t) => t.split(','))
      .map((t) => t.trim())
      .filter(Boolean);

    if (asked.length === 0) return new Set(SEARCH_TYPES);

    const valid = asked.filter((t): t is SearchType =>
      (SEARCH_TYPES as readonly string[]).includes(t),
    );
    // An unrecognised type list would otherwise search nothing and read as
    // "no results" rather than "that filter is not a thing".
    return new Set(valid.length > 0 ? valid : SEARCH_TYPES);
  }

  private async orgWabaIds(ssoOrgId: string): Promise<string[]> {
    const rows = await this.prisma.waba.findMany({
      where: { ssoOrgId },
      select: { wabaId: true },
    });
    return rows.map((w) => w.wabaId);
  }
}

/** What every per-type search needs, resolved once. */
interface Scope {
  ssoOrgId: string;
  q: string;
  limit: number;
  wabaIds: string[];
}

export { SearchResultDto };
