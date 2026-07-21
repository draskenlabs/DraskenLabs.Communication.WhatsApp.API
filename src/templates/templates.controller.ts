import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { TemplatesService } from './templates.service';
import { TemplateResponseDto, TemplateSyncResponseDto } from './dto/template.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
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
    description: 'Fetches all message templates from the Meta Graph API and upserts them into the local database.',
  })
  @ApiWrappedOkResponse({ dataDto: TemplateSyncResponseDto, description: 'Sync result' })
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
  @ApiWrappedOkResponse({ dataDto: TemplateResponseDto, description: 'Created template (pending review)' })
  @ApiStandardErrorResponses({ unauthorized: true, badRequest: true, validation: true })
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

  @Get()
  @ApiOperation({ summary: 'List all templates for the current organisation' })
  @ApiQuery({ name: 'wabaId', required: false, description: 'Filter by WABA ID' })
  @ApiWrappedOkResponse({ dataDto: TemplateResponseDto, isArray: true, description: 'Template list' })
  async findAll(
    @Req() req: Request,
    @Query('wabaId') wabaId?: string,
  ): Promise<TemplateResponseDto[]> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException();
    return this.templatesService.findAll(orgId, wabaId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single template by ID' })
  @ApiWrappedOkResponse({ dataDto: TemplateResponseDto, description: 'Template detail' })
  async findOne(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<TemplateResponseDto> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException();
    return this.templatesService.findOne(orgId, id);
  }
}
