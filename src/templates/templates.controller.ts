import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { TemplateCategory, TemplateStatus } from '@prisma/client';
import { TemplatesService } from './templates.service';
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
import { PaginationMetaDto } from 'src/common/responses/swagger-response.dto';
import { BaseResponse } from 'src/common/responses/base-response';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

@ApiTags('Templates')
@ApiBearerAuth()
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Post('sync/:wabaId')
  @ApiOperation({
    summary: 'Sync templates from Meta for a WABA',
    description:
      'Fetches all message templates from the Meta Graph API and upserts them into the local database.',
  })
  @ApiWrappedOkResponse({
    dataDto: TemplateSyncResponseDto,
    description: 'Sync result',
  })
  async sync(
    @Req() req: Request,
    @Param('wabaId') wabaId: string,
  ): Promise<TemplateSyncResponseDto> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException();
    return this.templatesService.syncTemplates(user.id, orgId, wabaId);
  }

  @Post(':wabaId')
  @ApiOperation({
    summary: 'Create a message template for a WABA',
    description:
      'Submits a new template to the Meta Cloud API (`POST /{waba-id}/message_templates`) and stores it locally. ' +
      'The template is created with status PENDING; approval arrives asynchronously via the ' +
      'message_template_status_update webhook.',
  })
  @ApiWrappedOkResponse({
    dataDto: TemplateResponseDto,
    description: 'Created template (pending review)',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    badRequest: true,
    validation: true,
  })
  async create(
    @Req() req: Request,
    @Param('wabaId') wabaId: string,
    @Body() dto: CreateTemplateDto,
  ): Promise<TemplateResponseDto> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException();
    return this.templatesService.createTemplate(user.id, orgId, wabaId, dto);
  }

  @Post('migrate/:destinationWabaId')
  @ApiOperation({
    summary: 'Migrate approved templates from another WABA',
    description:
      'Asks the destination WABA to copy templates from a source WABA (`POST /{waba-id}/migrate_message_templates`). ' +
      'The caller must own both. Only APPROVED templates with a GREEN or UNKNOWN quality score are eligible; ' +
      'anything Meta refuses is returned with its reason. Copies are synced locally on success.',
  })
  @ApiWrappedOkResponse({
    dataDto: MigrateTemplatesResultDto,
    description: 'What was migrated, and what Meta refused',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    badRequest: true,
    validation: true,
  })
  async migrate(
    @Req() req: Request,
    @Param('destinationWabaId') destinationWabaId: string,
    @Body() dto: MigrateTemplatesDto,
  ): Promise<MigrateTemplatesResultDto> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException();
    return this.templatesService.migrateTemplates(
      user.id,
      orgId,
      destinationWabaId,
      dto,
    );
  }

  @Get('library/:wabaId')
  @ApiOperation({
    summary: "Browse Meta's Template Library",
    description:
      'Proxies `GET /message_template_library`. These are pre-written utility templates a business ' +
      'can adopt as-is; the body is fixed and only the marked inputs (a phone number, a URL) are ' +
      'yours to supply. The WABA in the path selects which access token to call Meta with.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Free-text substring, e.g. "payment"',
  })
  @ApiQuery({
    name: 'topic',
    required: false,
    description:
      'ACCOUNT_UPDATE | CUSTOMER_FEEDBACK | ORDER_MANAGEMENT | PAYMENTS',
  })
  @ApiQuery({
    name: 'usecase',
    required: false,
    description: 'e.g. ORDER_CONFIRMATION',
  })
  @ApiQuery({
    name: 'industry',
    required: false,
    description: 'E_COMMERCE | FINANCIAL_SERVICES',
  })
  @ApiQuery({
    name: 'language',
    required: false,
    description: 'Locale code, e.g. en_US',
  })
  @ApiWrappedOkResponse({
    dataDto: LibraryTemplateDto,
    isArray: true,
    description: 'Library templates matching the filters',
  })
  @ApiStandardErrorResponses({ unauthorized: true, badRequest: true })
  async listLibrary(
    @Req() req: Request,
    @Param('wabaId') wabaId: string,
    @Query() filters: ListTemplateLibraryDto,
  ): Promise<LibraryTemplateDto[]> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException();
    return this.templatesService.listLibrary(user.id, orgId, wabaId, filters);
  }

  @Post('library/:wabaId')
  @ApiOperation({
    summary: 'Adopt a library template into a WABA',
    description:
      'Creates a template from a Template Library entry. Meta copies the fixed content itself, so ' +
      'only the library name and any required button inputs are sent. Library templates are always ' +
      'UTILITY, and arrive PENDING — approval is usually quick because the wording is pre-vetted.',
  })
  @ApiWrappedOkResponse({
    dataDto: TemplateResponseDto,
    description: 'Created template (pending review)',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    badRequest: true,
    validation: true,
  })
  async createFromLibrary(
    @Req() req: Request,
    @Param('wabaId') wabaId: string,
    @Body() dto: CreateFromLibraryDto,
  ): Promise<TemplateResponseDto> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException();
    return this.templatesService.createFromLibrary(user.id, orgId, wabaId, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List templates for the current organisation',
    description:
      'Returns all templates by default. Supply `page`/`limit` to paginate ' +
      '(response then includes a `meta` block); filter with `status`/`category`.',
  })
  @ApiQuery({
    name: 'wabaId',
    required: false,
    description: 'Filter by WABA ID',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: TemplateStatus,
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    enum: TemplateCategory,
    description: 'Filter by category',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-based page number (enables pagination)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size, 1–100 (enables pagination)',
  })
  @ApiWrappedOkResponse({
    dataDto: TemplateResponseDto,
    isArray: true,
    metaDto: PaginationMetaDto,
    description: 'Template list',
  })
  async findAll(
    @Req() req: Request,
    @Query('wabaId') wabaId?: string,
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<BaseResponse<TemplateResponseDto[]>> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException();
    return this.templatesService.findAll(orgId, {
      wabaId,
      status,
      category,
      page: page !== undefined ? Number(page) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
  }

  // Declared before `:id` so "status-counts" is not read as a template id.
  @Get('status-counts')
  @ApiOperation({
    summary: 'Count templates per status',
    description:
      'Counts across every page, so a paginated list can still show how many ' +
      'templates sit behind each status. Pass `category` to count within one ' +
      'category, matching a list filtered the same way.',
  })
  @ApiQuery({
    name: 'wabaId',
    required: false,
    description: 'Limit the counts to one WABA',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'],
    description: 'Count within one category only',
  })
  @ApiWrappedOkResponse({
    dataDto: TemplateStatusCountsDto,
    description: 'Totals per status',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  async statusCounts(
    @Req() req: Request,
    @Query('wabaId') wabaId?: string,
    @Query('category') category?: string,
  ): Promise<TemplateStatusCountsDto> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException();
    return this.templatesService.statusCounts(orgId, wabaId, category);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single template by ID' })
  @ApiWrappedOkResponse({
    dataDto: TemplateResponseDto,
    description: 'Template detail',
  })
  async findOne(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<TemplateResponseDto> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException();
    return this.templatesService.findOne(orgId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a message template',
    description:
      'Submits an edit to the Meta Cloud API (`POST /{message-template-id}`). ' +
      'Only components and category are editable; name and language are immutable.',
  })
  @ApiWrappedOkResponse({
    dataDto: TemplateResponseDto,
    description: 'Updated template',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    badRequest: true,
    validation: true,
  })
  async update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTemplateDto,
  ): Promise<TemplateResponseDto> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException();
    return this.templatesService.updateTemplate(user.id, orgId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a message template',
    description:
      'Deletes the template from Meta and soft-deletes the local record ' +
      '(status set to DELETED, kept for audit).',
  })
  @ApiStandardErrorResponses({ unauthorized: true, badRequest: true })
  async remove(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException();
    return this.templatesService.deleteTemplate(user.id, orgId, id);
  }
}
