import {
  Controller,
  Get,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AnalyticsService, AnalyticsQuery } from './analytics.service';
import {
  AnalyticsOverviewDto,
  ContactAnalyticsDto,
  MessageAnalyticsDetailDto,
  PhoneNumberAnalyticsDto,
  TemplateAnalyticsDto,
} from './dto/analytics.dto';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

/** Filters every endpoint shares, documented once. */
const RANGE_QUERIES = [
  {
    name: 'days',
    required: false,
    type: Number,
    description: 'Range in days, 1–90 (default 14)',
  },
  {
    name: 'wabaId',
    required: false,
    type: String,
    description:
      'Limit to one WhatsApp Business Account. Messages carry a phone ' +
      'number rather than a WABA, so this resolves to that account’s numbers.',
  },
  {
    name: 'phoneNumberId',
    required: false,
    type: String,
    description: 'Limit to one phone number',
  },
] as const;

const withRangeQueries = (
  target: object,
  key: string | symbol,
  descriptor: PropertyDescriptor,
): void => {
  for (const q of RANGE_QUERIES) ApiQuery(q)(target, key, descriptor);
};

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Headline metrics, daily series and the delivery funnel',
    description:
      'One call for everything the dashboard shows. Each stat carries the ' +
      'same figure from the period immediately before, so a number can be ' +
      'read as a change rather than in isolation.',
  })
  @withRangeQueries
  @ApiWrappedOkResponse({
    dataDto: AnalyticsOverviewDto,
    description: 'Overview metrics',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  overview(@Req() req: Request): Promise<AnalyticsOverviewDto> {
    const { orgId, query } = this.scope(req);
    return this.analytics.overview(orgId, query);
  }

  @Get('messages')
  @ApiOperation({
    summary: 'Message volume, mix, failure reasons and send-time heatmap',
    description:
      'Also reports median time to delivery and to read, which are null ' +
      'until enough messages carry those timestamps — they were not ' +
      'recorded before and cannot be backfilled.',
  })
  @withRangeQueries
  @ApiWrappedOkResponse({
    dataDto: MessageAnalyticsDetailDto,
    description: 'Message analytics',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  messages(@Req() req: Request): Promise<MessageAnalyticsDetailDto> {
    const { orgId, query } = this.scope(req);
    return this.analytics.messages(orgId, query);
  }

  @Get('templates')
  @ApiOperation({
    summary: 'Per-template delivery and read rates, plus the approval funnel',
    description:
      'Performance covers templates actually used in the range. Messages ' +
      'sent before the template name was recorded do not appear — the name ' +
      'lives inside the payload for those, and guessing would be worse than ' +
      'omitting them.',
  })
  @withRangeQueries
  @ApiWrappedOkResponse({
    dataDto: TemplateAnalyticsDto,
    description: 'Template analytics',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  templates(@Req() req: Request): Promise<TemplateAnalyticsDto> {
    const { orgId, query } = this.scope(req);
    return this.analytics.templates(orgId, query);
  }

  @Get('contacts')
  @ApiOperation({
    summary: 'Contact growth and opt-out rate',
    description:
      'Opt-outs recorded before their date was captured are reported ' +
      'separately as `optedOutUndated`, rather than dated to today and drawn ' +
      'as a spike that never happened.',
  })
  @withRangeQueries
  @ApiWrappedOkResponse({
    dataDto: ContactAnalyticsDto,
    description: 'Contact analytics',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  contacts(@Req() req: Request): Promise<ContactAnalyticsDto> {
    const { orgId, query } = this.scope(req);
    return this.analytics.contacts(orgId, query);
  }

  @Get('phone-numbers')
  @ApiOperation({
    summary: 'Per-number volume, failure rate and quality history',
    description:
      'Quality history is only as long as the time since ratings started ' +
      'being recorded: the number’s own rating column is overwritten on each ' +
      'sync, so nothing before that is recoverable.',
  })
  @withRangeQueries
  @ApiWrappedOkResponse({
    dataDto: PhoneNumberAnalyticsDto,
    description: 'Phone number analytics',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  phoneNumbers(@Req() req: Request): Promise<PhoneNumberAnalyticsDto> {
    const { orgId, query } = this.scope(req);
    return this.analytics.phoneNumbers(orgId, query);
  }

  @Get('export')
  @ApiOperation({
    summary: 'Download any of the above as CSV',
    description:
      'Returns a text/csv attachment rather than the usual JSON envelope, so ' +
      'a browser, a spreadsheet or a scheduled job can fetch it directly.',
  })
  @ApiQuery({
    name: 'dataset',
    required: false,
    enum: ['overview', 'messages', 'templates', 'contacts', 'phone-numbers'],
    description: 'Which table to export (default overview)',
  })
  @withRangeQueries
  @ApiStandardErrorResponses({ unauthorized: true })
  async export(
    @Req() req: Request,
    @Res() res: Response,
    @Query('dataset') dataset = 'overview',
  ): Promise<void> {
    const { orgId, query } = this.scope(req);
    const { filename, csv } = await this.analytics.exportCsv(
      orgId,
      dataset,
      query,
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  /** The organisation on the request, plus the filters, read once. */
  private scope(req: Request): { orgId: string; query: AnalyticsQuery } {
    const { orgId, query } = req as Request & { orgId?: string };
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');

    const read = (key: string): string | undefined => {
      const value = (query as Record<string, unknown>)[key];
      return typeof value === 'string' && value ? value : undefined;
    };
    const days = read('days');

    return {
      orgId,
      query: {
        days: days !== undefined ? Number(days) : undefined,
        wabaId: read('wabaId'),
        phoneNumberId: read('phoneNumberId'),
      },
    };
  }
}
