import { Controller, Post, Get, Delete, Body, Req, Param, ParseIntPipe, HttpCode, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto, ApiKeyResponseDto, ApiKeyListResponseDto } from './dto/api-key.dto';
import { Request } from 'express';
import { ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('API Keys')
@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new API key' })
  @ApiWrappedOkResponse({
    dataDto: ApiKeyResponseDto,
    description: 'Create API key',
  })
  async create(@Req() req: Request, @Body() dto: CreateApiKeyDto): Promise<ApiKeyResponseDto> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException('User not found in context');
    return this.apiKeyService.createApiKey(user.id, orgId, dto);
  }

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all API keys for current user' })
  @ApiWrappedOkResponse({
    dataDto: ApiKeyListResponseDto,
    isArray: true,
    description: 'List API keys',
  })
  async findAll(@Req() req: Request) {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    return this.apiKeyService.findAllByOrgId(orgId);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke an API key' })
  async revoke(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    const user = (req as any).user;
    if (!user) {
      throw new UnauthorizedException('User not found in context');
    }
    const orgId = (req as any).orgId;
    if (!orgId) {
      throw new UnauthorizedException('Organisation not found in context');
    }
    await this.apiKeyService.revokeApiKey(user.id, orgId, id);
  }
}
