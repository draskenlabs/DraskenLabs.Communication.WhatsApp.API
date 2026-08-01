import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateContactDto, UpdateContactDto, ContactResponseDto } from './dto/contact.dto';
import { BaseResponse } from 'src/common/responses/base-response';

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ssoOrgId: string, dto: CreateContactDto): Promise<ContactResponseDto> {
    const existing = await this.prisma.contact.findUnique({
      where: { ssoOrgId_phone: { ssoOrgId, phone: dto.phone } },
    });
    if (existing) throw new BadRequestException('A contact with this phone number already exists');

    const contact = await this.prisma.contact.create({
      data: {
        ssoOrgId,
        phone: dto.phone,
        name: dto.name ?? null,
        email: dto.email ?? null,
        metadata: dto.metadata ?? undefined,
      },
    });

    return this.toDto(contact);
  }

  async findAll(
    ssoOrgId: string,
    opts: { page?: number; limit?: number } = {},
  ): Promise<BaseResponse<ContactResponseDto[]>> {
    const where = { ssoOrgId };

    // Paginate only when asked; otherwise return the full contact list.
    if (opts.page !== undefined || opts.limit !== undefined) {
      const page = Math.max(1, opts.page ?? 1);
      const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
      const [rows, total] = await this.prisma.$transaction([
        this.prisma.contact.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.contact.count({ where }),
      ]);
      const totalPages = Math.ceil(total / limit);
      return BaseResponse.paginate(rows.map(this.toDto), total, totalPages, page, limit);
    }

    const contacts = await this.prisma.contact.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return BaseResponse.success(contacts.map(this.toDto));
  }

  async findOne(ssoOrgId: string, id: number): Promise<ContactResponseDto> {
    const contact = await this.prisma.contact.findUnique({ where: { id } });
    if (!contact || contact.ssoOrgId !== ssoOrgId) throw new NotFoundException('Contact not found');
    return this.toDto(contact);
  }

  async update(ssoOrgId: string, id: number, dto: UpdateContactDto): Promise<ContactResponseDto> {
    const contact = await this.prisma.contact.findUnique({ where: { id } });
    if (!contact || contact.ssoOrgId !== ssoOrgId) throw new NotFoundException('Contact not found');

    const updated = await this.prisma.contact.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.optedOut !== undefined && {
          optedOut: dto.optedOut,
          // The flag says what is true now; the date is what can be trended,
          // and it cannot be recovered later. Cleared on opting back in.
          optedOutAt: dto.optedOut ? (contact.optedOutAt ?? new Date()) : null,
        }),
        ...(dto.metadata !== undefined && { metadata: dto.metadata }),
      },
    });

    return this.toDto(updated);
  }

  async remove(ssoOrgId: string, id: number): Promise<void> {
    const contact = await this.prisma.contact.findUnique({ where: { id } });
    if (!contact || contact.ssoOrgId !== ssoOrgId) throw new NotFoundException('Contact not found');
    await this.prisma.contact.delete({ where: { id } });
  }

  async isOptedOut(ssoOrgId: string, phone: string): Promise<boolean> {
    const contact = await this.prisma.contact.findUnique({
      where: { ssoOrgId_phone: { ssoOrgId, phone } },
      select: { optedOut: true },
    });
    return contact?.optedOut ?? false;
  }

  private toDto(c: any): ContactResponseDto {
    return {
      id: c.id,
      phone: c.phone,
      name: c.name ?? undefined,
      email: c.email ?? undefined,
      optedOut: c.optedOut,
      metadata: c.metadata ?? undefined,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
