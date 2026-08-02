import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WabaService } from './waba.service';
import { Request } from 'express';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';
import {
  DeleteWabaResultDto,
  WabaResponseDto,
  MetaWabaDetailsDto,
} from './dto/waba-response.dto';

@ApiTags('WABAs')
@Controller('wabas')
export class WabaController {
  constructor(private readonly wabaService: WabaService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all WABAs for current user' })
  @ApiWrappedOkResponse({
    dataDto: WabaResponseDto,
    isArray: true,
    description: 'List all WABAs',
  })
  async findAll(@Req() req: Request): Promise<WabaResponseDto[]> {
    const { user, orgId } = req as Request & {
      user?: { id: number };
      orgId?: string;
    };
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    // Scoped to the caller: "connected" means *this* user holds a token, which
    // is what decides whether sync and send will work for them.
    return this.wabaService.findAllByOrgId(orgId, user?.id);
  }

  @Get('/:wabaId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get specific WABA details from Meta Graph API' })
  @ApiWrappedOkResponse({
    dataDto: MetaWabaDetailsDto,
    description: 'WABA details from Meta',
  })
  async findDetails(
    @Param('wabaId') wabaId: string,
    @Req() req: Request,
  ): Promise<any> {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedException('User not found in context');
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    return this.wabaService.getWabaDetailsFromMeta(orgId, wabaId, user.id);
  }

  @Post('/:wabaId/sync')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sync WABA details from Meta Graph API to database',
  })
  @ApiWrappedOkResponse({
    dataDto: WabaResponseDto,
    description: 'Synced WABA details',
  })
  async syncWaba(
    @Param('wabaId') wabaId: string,
    @Req() req: Request,
  ): Promise<WabaResponseDto> {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedException('User not found in context');
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');

    // Membership first. Sync re-upserts the account *and* its organisation row,
    // so without this check it was an undocumented way to attach any account
    // the caller held a token for to whatever organisation they were currently
    // in. Joining an organisation to an account is the connect flow's job.
    const metaDetails = await this.wabaService.getWabaDetailsFromMeta(
      orgId,
      wabaId,
      user.id,
    );

    const waba = await this.wabaService.createOrUpdateWaba({
      wabaId: metaDetails.id,
      userId: user.id,
      ssoOrgId: orgId,
      name: metaDetails.name,
      currency: metaDetails.currency,
      timezoneId: metaDetails.timezone_id,
      messageTemplateNamespace: metaDetails.message_template_namespace,
    });

    // (Re)subscribe our app to this WABA's webhooks — lets already-connected
    // WABAs start receiving delivery/read statuses without re-onboarding.
    await this.wabaService.subscribeExistingWaba(orgId, wabaId, user.id);

    // Reaching here means the caller's token worked, so the account is
    // connected by definition.
    return { ...waba, connected: true };
  }

  @Delete('/:wabaId/connect')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Disconnect a WABA',
    description:
      'Removes your access token for this WABA and invalidates all associated phone number caches. ' +
      'The WABA and phone number records are preserved for audit purposes.',
  })
  async disconnect(
    @Param('wabaId') wabaId: string,
    @Req() req: Request,
  ): Promise<void> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException('User not found in context');
    return this.wabaService.disconnectWaba(user.id, orgId, wabaId);
  }

  @Delete('/:wabaId')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete a WABA and everything we hold about it',
    description:
      'Removes the account record, its phone numbers, templates, sent and ' +
      'received messages, stored webhook events, and every member’s access ' +
      'token. Disconnecting keeps all of that for audit — this is how it is ' +
      'finally discarded, and it cannot be undone. ' +
      'Only the person who connected the account may delete it. ' +
      'Your WhatsApp Business Account, its phone numbers and its approved ' +
      'templates all stay with Meta and can be connected again afterwards.',
  })
  @ApiWrappedOkResponse({
    dataDto: DeleteWabaResultDto,
    description: 'What was deleted',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    forbidden: true,
    notFound: true,
  })
  async remove(
    @Param('wabaId') wabaId: string,
    @Req() req: Request,
  ): Promise<DeleteWabaResultDto> {
    const { user, orgId } = req as Request & {
      user?: { id: number };
      orgId?: string;
    };
    if (!user || !orgId) {
      throw new UnauthorizedException('User not found in context');
    }
    return this.wabaService.deleteWaba(user.id, orgId, wabaId);
  }
}
