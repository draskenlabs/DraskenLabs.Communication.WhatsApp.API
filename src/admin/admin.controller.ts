import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiOperation,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdminGuard, actorOf } from './admin.guard';
import { AdminService } from './admin.service';
import { InvoiceService } from 'src/billing/invoice.service';
import {
  AdminAuditPageDto,
  AdminInvoicePageDto,
  AdminMeDto,
  AdminOrganisationDetailDto,
  AdminOrganisationPageDto,
  AdminOverviewDto,
  AdminPlanDto,
  AdminSubscriptionRowDto,
  AdminAgencyRowDto,
  AdminAnalyticsDto,
  AdminUserDetailDto,
  AdminUserDto,
  AdminUserPageDto,
  AttachClientDto,
  ConvertOrgDto,
  CreatePlanDto,
  SetAdminDto,
  UpdatePlanDto,
} from './dto/admin.dto';

/**
 * The operator console.
 *
 * Excluded from the published API documentation — not as a security measure,
 * which the guard is, but because none of this is a customer's to call and
 * listing it would only invite the attempt.
 */
@ApiExcludeController()
@ApiBearerAuth()
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    // Only to render one. Which invoices an operator may see is not a
    // question — this console crosses every organisation boundary by design.
    private readonly invoices: InvoiceService,
  ) {}

  /**
   * Whether the caller is an operator.
   *
   * The console asks this before rendering anything. A non-admin never gets an
   * answer — the guard has already made the whole prefix a 404 — which is what
   * lets the browser show its not-found page without knowing why.
   */
  @Get('me')
  @ApiOperation({ summary: 'The operator behind this request' })
  me(@Req() req: Request): AdminMeDto {
    const actor = actorOf(req);
    return { id: actor.id, email: actor.email, name: actor.name };
  }

  @Get('overview')
  overview(): Promise<AdminOverviewDto> {
    return this.admin.overview();
  }

  @Get('organisations')
  organisations(
    @Query('search') search?: string,
    @Query('page') page?: string,
  ): Promise<AdminOrganisationPageDto> {
    return this.admin.organisations({
      search,
      page: page ? Number(page) : undefined,
    });
  }

  @Get('organisations/:ssoOrgId')
  organisation(
    @Param('ssoOrgId') ssoOrgId: string,
  ): Promise<AdminOrganisationDetailDto> {
    return this.admin.organisation(ssoOrgId);
  }

  @Get('subscriptions')
  subscriptions(
    @Query('status') status?: string,
  ): Promise<AdminSubscriptionRowDto[]> {
    return this.admin.subscriptions(status);
  }

  @Get('invoices')
  invoiceList(
    @Query('search') search?: string,
    @Query('ssoOrgId') ssoOrgId?: string,
    @Query('page') page?: string,
  ): Promise<AdminInvoicePageDto> {
    return this.admin.invoices({
      search,
      ssoOrgId,
      page: page ? Number(page) : undefined,
    });
  }

  @Get('invoices/:number/pdf')
  async invoicePdf(
    @Param('number') number: string,
    @Res() res: Response,
  ): Promise<void> {
    const invoice = await this.admin.invoice(number);
    const pdf = this.invoices.pdf(invoice);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${this.invoices.filename(invoice)}"`,
    );
    res.setHeader('Content-Length', String(pdf.length));
    res.end(pdf);
  }

  /** For the support case this screen exists for: "it never arrived". */
  @Post('invoices/:number/resend')
  @HttpCode(200)
  resendInvoice(
    @Req() req: Request,
    @Param('number') number: string,
  ): Promise<{ sent: boolean; to: string | null }> {
    return this.admin.resendInvoice(actorOf(req), number);
  }

  @Get('plans')
  plans(): Promise<AdminPlanDto[]> {
    return this.admin.plans();
  }

  @Post('plans')
  createPlan(
    @Req() req: Request,
    @Body() dto: CreatePlanDto,
  ): Promise<AdminPlanDto> {
    return this.admin.createPlan(actorOf(req), dto);
  }

  @Patch('plans/:code')
  updatePlan(
    @Req() req: Request,
    @Param('code') code: string,
    @Body() dto: UpdatePlanDto,
  ): Promise<AdminPlanDto> {
    return this.admin.updatePlan(actorOf(req), code, dto);
  }

  // --- Agency, with a named operator behind it rather than a shared token ---

  @Post('organisations/:ssoOrgId/agency')
  convert(
    @Req() req: Request,
    @Param('ssoOrgId') ssoOrgId: string,
    @Body() dto: ConvertOrgDto,
  ): Promise<{ ssoOrgId: string; isAgency: boolean }> {
    return this.admin.convert(actorOf(req), ssoOrgId, dto.isAgency);
  }

  @Post('organisations/:agencyOrgId/clients')
  attachClient(
    @Req() req: Request,
    @Param('agencyOrgId') agencyOrgId: string,
    @Body() dto: AttachClientDto,
  ) {
    return this.admin.attachClient(
      actorOf(req),
      agencyOrgId,
      dto.ssoOrgId,
      dto.clientName,
    );
  }

  @Delete('organisations/:agencyOrgId/clients/:ssoOrgId')
  @HttpCode(200)
  async detachClient(
    @Req() req: Request,
    @Param('agencyOrgId') agencyOrgId: string,
    @Param('ssoOrgId') ssoOrgId: string,
  ): Promise<{ ok: true }> {
    await this.admin.detachClient(actorOf(req), agencyOrgId, ssoOrgId);
    return { ok: true };
  }

  // --- Who else may use this console ---

  @Get('admins')
  admins(): Promise<AdminUserDto[]> {
    return this.admin.admins();
  }

  /**
   * The grant picker's search. Deliberately not a listing: it answers "who is
   * this person I am about to grant access to", and refuses a term short
   * enough to fish with.
   */
  @Get('users')
  findUsers(@Query('search') search?: string): Promise<AdminUserDto[]> {
    return this.admin.findUsers(search ?? '');
  }

  @Get('users/directory')
  @ApiOperation({
    summary:
      'Everybody with an account, and the organisations we have seen them in',
    description:
      'Memberships live in the SSO, so the organisations here are the ones ' +
      'this person connected an account for — not an authoritative roster. ' +
      'Somebody invited to an organisation who has connected nothing shows ' +
      'with none.',
  })
  directory(
    @Query('search') search?: string,
    @Query('page') page?: string,
  ): Promise<AdminUserPageDto> {
    return this.admin.users({
      search,
      page: page ? Number(page) : 1,
    });
  }

  @Get('users/:id')
  @ApiOperation({
    summary: 'One person, and the organisations we have seen them in',
    description:
      'Each organisation carries what it is on and who pays for it — an ' +
      'operator following somebody from a support ticket should not have to ' +
      'open three of them to find the one the ticket is about.',
  })
  user(@Param('id', ParseIntPipe) id: number): Promise<AdminUserDetailDto> {
    return this.admin.user(id);
  }

  @Get('agencies')
  @ApiOperation({
    summary: 'Every agency, and the clients under it',
    description:
      'The clients are the organisations the agency is being charged for, ' +
      'which is the relationship somebody is asked about when a bill is ' +
      'queried.',
  })
  agencies(): Promise<AdminAgencyRowDto[]> {
    return this.admin.agencies();
  }

  @Get('analytics')
  @ApiOperation({
    summary: 'Registrations, subscriptions and revenue, day by day',
    description:
      'Bucketed in the billing time zone rather than UTC, so a sign-up at ' +
      '03:00 IST belongs to that day. Every day in the range appears, ' +
      'including the empty ones — a series with gaps draws a chart that lies ' +
      'about its own shape.',
  })
  analytics(@Query('days') days?: string): Promise<AdminAnalyticsDto> {
    return this.admin.analytics(days ? Number(days) : 30);
  }

  @Patch('users/:id/admin')
  setAdmin(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetAdminDto,
  ): Promise<AdminUserDto> {
    return this.admin.setAdmin(actorOf(req), id, dto.isAdmin);
  }

  @Get('audit')
  audit(@Query('page') page?: string): Promise<AdminAuditPageDto> {
    return this.admin.auditLog(page ? Number(page) : 1);
  }
}
