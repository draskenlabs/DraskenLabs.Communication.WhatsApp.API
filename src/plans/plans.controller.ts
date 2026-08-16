import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
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
