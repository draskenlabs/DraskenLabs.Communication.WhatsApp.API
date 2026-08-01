import {
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { SearchService } from './search.service';
import { SearchQueryDto, SearchResponseDto } from './dto/search.dto';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

@ApiTags('Search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Search contacts, messages, templates, numbers and accounts',
    description:
      'One query across everything the console can link to, grouped by type ' +
      'and counted per type. Phone-shaped queries are matched against the ' +
      'stored digits, so "+44 7911 123456" finds the same row as "447911". ' +
      'A query shorter than two characters returns nothing rather than ' +
      'everything.',
  })
  @ApiWrappedOkResponse({
    dataDto: SearchResponseDto,
    description: 'Grouped results',
  })
  @ApiStandardErrorResponses({ unauthorized: true, badRequest: true })
  find(
    @Req() req: Request,
    @Query() query: SearchQueryDto,
  ): Promise<SearchResponseDto> {
    const { orgId } = req as Request & { orgId?: string };
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');

    return this.search.search(orgId, query.q, {
      limit: query.limit,
      types: query.types,
    });
  }
}
