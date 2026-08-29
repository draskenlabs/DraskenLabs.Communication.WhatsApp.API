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
  AdminUserDto,
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

  @Get('users')
  findUsers(@Query('search') search?: string): Promise<AdminUserDto[]> {
    return this.admin.findUsers(search ?? '');
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
