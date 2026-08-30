import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { Request } from 'express';
import { SsoTokenService } from 'src/auth/sso-token.service';
import { OrgService } from './org.service';
import {
  ApiWrappedOkResponse,
  ApiStandardErrorResponses,
} from 'src/common/responses/swagger.decorators';
import {
  OrganisationDto,
  MemberDto,
  InvitationDto,
  InviteMemberDto,
  UpdateMemberRoleDto,
  UpdateOrganisationDto,
} from './dto/org.dto';

@ApiTags('Organisations')
@ApiBearerAuth()
@ApiStandardErrorResponses({ unauthorized: true, forbidden: true })
@Controller('organisation')
export class OrgController {
  constructor(
    private readonly orgService: OrgService,
    private readonly ssoToken: SsoTokenService,
  ) {}

  /**
   * Verifies the caller's SSO access token and hands it straight back as an
   * `Authorization` header for the SSO.
   *
   * These routes are a thin proxy onto the SSO's own organisation API, and the
   * caller now holds the very token it wants: there is nothing to look up and
   * nothing stored on this side to go stale. It used to read a copy cached at
   * login, which a ten-minute access-token lifetime would have made stale
   * within minutes of the session starting.
   *
   * Still verified rather than forwarded blind, so a token minted for another
   * Drasken application cannot be relayed through this API into the SSO.
   */
  private async ssoAuth(req: Request): Promise<string> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7).trim()
      : undefined;
    if (!token) throw new UnauthorizedException('Missing Authorization header');
    await this.ssoToken.verify(token);
    return `Bearer ${token}`;
  }

  @Get()
  @ApiOperation({ summary: 'List organisations for the authenticated user' })
  @ApiWrappedOkResponse({
    dataDto: OrganisationDto,
    isArray: true,
    description: 'List of organisations',
  })
  async listOrgs(@Req() req: Request) {
    return this.orgService.listOrgs(await this.ssoAuth(req));
  }

  @Get(':orgId')
  @ApiOperation({ summary: 'Get organisation details' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({
    dataDto: OrganisationDto,
    description: 'Organisation details',
  })
  @ApiStandardErrorResponses({ notFound: true })
  async getOrg(@Param('orgId') orgId: string, @Req() req: Request) {
    return this.orgService.getOrg(orgId, await this.ssoAuth(req));
  }

  @Patch(':orgId')
  @ApiOperation({ summary: 'Update organisation name or slug (admin only)' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({
    dataDto: OrganisationDto,
    description: 'Updated organisation',
  })
  async updateOrg(
    @Param('orgId') orgId: string,
    @Req() req: Request,
    @Body() body: UpdateOrganisationDto,
  ) {
    return this.orgService.updateOrg(
      orgId,
      await this.ssoAuth(req),
      body as unknown as Record<string, unknown>,
    );
  }

  @Get(':orgId/members')
  @ApiOperation({ summary: 'List members of an organisation' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({
    dataDto: MemberDto,
    isArray: true,
    description: 'Organisation member list',
  })
  async listMembers(@Param('orgId') orgId: string, @Req() req: Request) {
    return this.orgService.listMembers(orgId, await this.ssoAuth(req));
  }

  @Post(':orgId/members/invite')
  @ApiOperation({ summary: 'Invite a user to the organisation' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({
    dataDto: InvitationDto,
    description: 'Created invitation',
  })
  async inviteMember(
    @Param('orgId') orgId: string,
    @Req() req: Request,
    @Body() body: InviteMemberDto,
  ) {
    return this.orgService.inviteMember(
      orgId,
      await this.ssoAuth(req),
      body as unknown as Record<string, unknown>,
    );
  }

  @Patch(':orgId/members/:userId/role')
  @ApiOperation({ summary: "Update a member's role (admin only)" })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiParam({ name: 'userId', description: 'SSO user ID' })
  @ApiWrappedOkResponse({ dataDto: MemberDto, description: 'Updated member' })
  async updateMemberRole(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
    @Body() body: UpdateMemberRoleDto,
  ) {
    return this.orgService.updateMemberRole(
      orgId,
      userId,
      await this.ssoAuth(req),
      body as unknown as Record<string, unknown>,
    );
  }

  @Delete(':orgId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a member from the organisation (admin only)',
  })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiParam({ name: 'userId', description: 'SSO user ID' })
  async removeMember(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.orgService.removeMember(orgId, userId, await this.ssoAuth(req));
  }

  @Get(':orgId/invitations')
  @ApiOperation({ summary: 'List pending invitations for an organisation' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({
    dataDto: InvitationDto,
    isArray: true,
    description: 'Pending invitations',
  })
  async listInvitations(@Param('orgId') orgId: string, @Req() req: Request) {
    return this.orgService.listInvitations(orgId, await this.ssoAuth(req));
  }
}
