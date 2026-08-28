import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AgencyService } from './agency.service';
import {
  AgencyRosterDto,
  AttachClientDto,
  ClientSummaryDto,
  ConvertAgencyDto,
  RenameClientDto,
} from './dto/agency.dto';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

@ApiTags('Agency')
@Controller('agency')
export class AgencyController {
  constructor(
    private readonly agency: AgencyService,
    private readonly config: ConfigService,
  ) {}

  @Get('clients')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The agency’s clients, and what they add up to',
    description:
      'One row per client with its accounts, numbers, contacts and messages ' +
      'this month, plus the totals against what the agency’s plan includes. ' +
      'Refused from an organisation that does not manage clients.',
  })
  @ApiWrappedOkResponse({ dataDto: AgencyRosterDto, description: 'Clients' })
  @ApiStandardErrorResponses({ forbidden: true })
  async clients(@Req() req: Request): Promise<AgencyRosterDto> {
    return this.agency.roster(this.orgOf(req));
  }

  @Patch('clients/:ssoOrgId')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Rename a client',
    description:
      'The label is the agency’s own — the client organisation keeps whatever ' +
      'it calls itself in the SSO.',
  })
  @ApiStandardErrorResponses({ notFound: true, forbidden: true })
  async rename(
    @Req() req: Request,
    @Param('ssoOrgId') ssoOrgId: string,
    @Body() dto: RenameClientDto,
  ): Promise<{ ssoOrgId: string; clientName: string }> {
    return this.agency.renameClient(this.orgOf(req), ssoOrgId, dto.clientName);
  }

  // ---------------------------------------------------------------------------
  // Operator-only. Both of these hand out something no plan describes — the
  // right to enter organisations you are not a member of, and a change to who
  // is billed — so they are behind a shared secret and off by default, in the
  // same shape as the mail broadcast endpoint.
  // ---------------------------------------------------------------------------

  @Post('internal/convert')
  @ApiExcludeEndpoint()
  async convert(
    @Headers('x-agency-admin-token') token: string | undefined,
    @Body() dto: ConvertAgencyDto,
  ): Promise<{ ssoOrgId: string; isAgency: boolean }> {
    this.assertOperator(token);
    return this.agency.convert(
      dto.ssoOrgId,
      dto.isAgency ?? true,
      dto.convertedBy,
    );
  }

  @Post('internal/clients')
  @ApiExcludeEndpoint()
  async attach(
    @Headers('x-agency-admin-token') token: string | undefined,
    @Body() dto: AttachClientDto,
  ): Promise<ClientSummaryDto> {
    this.assertOperator(token);
    return this.agency.attachClient(
      dto.agencyOrgId,
      dto.ssoOrgId,
      dto.clientName,
    );
  }

  @Delete('internal/clients/:agencyOrgId/:ssoOrgId')
  @ApiExcludeEndpoint()
  @HttpCode(200)
  async detach(
    @Headers('x-agency-admin-token') token: string | undefined,
    @Param('agencyOrgId') agencyOrgId: string,
    @Param('ssoOrgId') ssoOrgId: string,
  ): Promise<{ ok: true }> {
    this.assertOperator(token);
    await this.agency.detachClient(agencyOrgId, ssoOrgId);
    return { ok: true };
  }

  /** The organisation the token is scoped to. */
  private orgOf(req: Request): string {
    const ssoOrgId = (req as unknown as { orgId?: string }).orgId;
    if (!ssoOrgId) {
      throw new UnauthorizedException('Organisation not found in context');
    }
    return ssoOrgId;
  }

  private assertOperator(token: string | undefined): void {
    const expected = this.config.get<string>('AGENCY_ADMIN_TOKEN');
    if (!expected) {
      throw new ForbiddenException(
        'Agency administration is not enabled on this server.',
      );
    }
    if (!token || token !== expected) {
      throw new ForbiddenException('Invalid admin token.');
    }
  }
}
