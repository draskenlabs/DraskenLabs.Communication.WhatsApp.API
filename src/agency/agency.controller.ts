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
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AgencyService } from './agency.service';
import { InvoiceService } from 'src/billing/invoice.service';
import { InvoiceDto } from 'src/billing/dto/billing.dto';
import {
  AgencyMandateDto,
  AgencyRosterDto,
  AttachClientDto,
  ClientSubscribedDto,
  ClientSummaryDto,
  ConvertAgencyDto,
  CreateClientDto,
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
    // Only to render one: which invoices this agency may see is the service's
    // decision, not the controller's.
    private readonly invoices: InvoiceService,
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

  /**
   * Take on a client: create its organisation, attach it, and pay for it.
   *
   * One call because the three are one intent. Splitting them is what produced
   * phantom clients — an organisation id typed by hand into an attach endpoint
   * that never checked it existed.
   */
  @Get('mandates')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'What the agency pays, one line per mandate' })
  @ApiWrappedOkResponse({
    dataDto: AgencyMandateDto,
    isArray: true,
    description: 'One per plan the agency has clients on',
  })
  async mandates(@Req() req: Request): Promise<AgencyMandateDto[]> {
    return this.agency.mandates(this.orgOf(req));
  }

  @Get('invoices')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The agency’s invoices, and its clients’ own',
    description:
      'Its own are what it is paying now, one document per debit, itemised ' +
      'by client. Its clients’ are what they paid for themselves before they ' +
      'were taken on, or after they were let go — an agency asked to explain ' +
      'a client’s billing history needs the whole of it.',
  })
  @ApiWrappedOkResponse({
    dataDto: InvoiceDto,
    isArray: true,
    description: 'Invoices, newest first',
  })
  async invoiceList(@Req() req: Request): Promise<InvoiceDto[]> {
    return this.agency.invoices(this.orgOf(req));
  }

  @Get('invoices/:number/pdf')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'One of those invoices as a PDF',
    description:
      'The same document that was emailed when the payment was taken. ' +
      'Scoped to the agency and its roster — the numbers are sequential, so ' +
      'an unscoped lookup would let any agency walk the whole series.',
  })
  @ApiStandardErrorResponses()
  async invoicePdf(
    @Req() req: Request,
    @Param('number') number: string,
    @Res() res: Response,
  ): Promise<void> {
    const invoice = await this.agency.invoice(this.orgOf(req), number);
    const pdf = this.invoices.pdf(invoice);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${this.invoices.filename(invoice)}"`,
    );
    res.setHeader('Content-Length', String(pdf.length));
    res.end(pdf);
  }

  @Post('clients')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a client and subscribe it to a plan' })
  @ApiWrappedOkResponse({
    dataDto: ClientSubscribedDto,
    description: 'The client, and the mandate covering it',
  })
  async createClient(
    @Req() req: Request,
    @Body() dto: CreateClientDto,
  ): Promise<ClientSubscribedDto> {
    const request = req as Request & {
      user?: { id: number };
      ssoAccessToken?: string;
    };
    if (!request.user?.id || !request.ssoAccessToken) {
      throw new UnauthorizedException('Session not found in context');
    }
    return this.agency.createClient(this.orgOf(req), {
      name: dto.name,
      planCode: dto.planCode,
      userId: request.user.id,
      ssoAccessToken: request.ssoAccessToken,
    });
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
