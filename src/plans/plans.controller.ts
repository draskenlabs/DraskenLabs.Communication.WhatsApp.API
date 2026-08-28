import {
  Controller,
  Get,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { PlansService } from './plans.service';
import { PlanDto } from './dto/plan.dto';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

@ApiTags('Plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOperation({
    summary: 'The published price list',
    description:
      'Every plan on offer, in published order, with its price, limits and ' +
      'feature list. Unauthenticated: this is what the pricing page renders, ' +
      'and somebody deciding whether to sign up has no session yet.',
  })
  @ApiWrappedOkResponse({
    dataDto: PlanDto,
    isArray: true,
    description: 'Plans',
  })
  async findAll(): Promise<PlanDto[]> {
    return this.plans.findAll();
  }

  @Get('mine')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The price list as this organisation sees it',
    description:
      'The published tiers plus any plan negotiated for this organisation. ' +
      'An agreed rate lives in the same table as the price list but is not ' +
      'part of it, so it is only ever answered to a caller we can identify. ' +
      'Declared above `:code` so the word is read as a route, not a plan code.',
  })
  @ApiWrappedOkResponse({
    dataDto: PlanDto,
    isArray: true,
    description: 'Plans',
  })
  async findMine(@Req() req: Request): Promise<PlanDto[]> {
    const ssoOrgId = (req as unknown as { orgId?: string }).orgId;
    if (!ssoOrgId) {
      throw new UnauthorizedException('Organisation not found in context');
    }
    return this.plans.findAll(ssoOrgId);
  }

  @Get(':code')
  @ApiOperation({ summary: 'One plan by its code' })
  @ApiParam({
    name: 'code',
    description: 'starter, growth, business or agency',
  })
  @ApiWrappedOkResponse({ dataDto: PlanDto, description: 'Plan' })
  @ApiStandardErrorResponses({
    notFound: true,
    unauthorized: false,
    forbidden: false,
    badRequest: false,
  })
  async findOne(@Param('code') code: string): Promise<PlanDto> {
    return this.plans.findByCode(code);
  }
}
