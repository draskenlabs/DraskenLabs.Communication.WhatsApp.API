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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from 'src/redis/redis.service';
import { OrgService } from './org.service';
import { ApiWrappedOkResponse, ApiStandardErrorResponses } from 'src/common/responses/swagger.decorators';
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
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Authenticates the app JWT (session or org-scoped) and returns the SSO
   * `Authorization` header built from the cached SSO access token — so the
   * browser never needs the SSO token to manage organisations.
   */
  private async ssoAuth(req: Request): Promise<string> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw new UnauthorizedException('Missing Authorization header');
    let sessionId: string | undefined;
    try {
      const payload = await this.jwtService.verifyAsync(token);
      sessionId = payload?.sessionId;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    if (!sessionId) throw new UnauthorizedException('Invalid session token');
    const session = await this.redisService.getSsoSession(sessionId);
    if (!session) throw new UnauthorizedException('Session expired — please sign in again');
    return `Bearer ${session.ssoAccessToken}`;
  }

  @Get()
  @ApiOperation({ summary: 'List organisations for the authenticated user' })
  @ApiWrappedOkResponse({ dataDto: OrganisationDto, isArray: true, description: 'List of organisations' })
  async listOrgs(@Req() req: Request) {
    return this.orgService.listOrgs(await this.ssoAuth(req));
  }

  @Get(':orgId')
  @ApiOperation({ summary: 'Get organisation details' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({ dataDto: OrganisationDto, description: 'Organisation details' })
  @ApiStandardErrorResponses({ notFound: true })
  async getOrg(@Param('orgId') orgId: string, @Req() req: Request) {
    return this.orgService.getOrg(orgId, await this.ssoAuth(req));
  }

  @Patch(':orgId')
  @ApiOperation({ summary: 'Update organisation name or slug (admin only)' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({ dataDto: OrganisationDto, description: 'Updated organisation' })
  async updateOrg(@Param('orgId') orgId: string, @Req() req: Request, @Body() body: UpdateOrganisationDto) {
    return this.orgService.updateOrg(orgId, await this.ssoAuth(req), body as unknown as Record<string, unknown>);
  }

  @Get(':orgId/members')
  @ApiOperation({ summary: 'List members of an organisation' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({ dataDto: MemberDto, isArray: true, description: 'Organisation member list' })
  async listMembers(@Param('orgId') orgId: string, @Req() req: Request) {
    return this.orgService.listMembers(orgId, await this.ssoAuth(req));
  }

  @Post(':orgId/members/invite')
  @ApiOperation({ summary: 'Invite a user to the organisation' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({ dataDto: InvitationDto, description: 'Created invitation' })
  async inviteMember(@Param('orgId') orgId: string, @Req() req: Request, @Body() body: InviteMemberDto) {
    return this.orgService.inviteMember(orgId, await this.ssoAuth(req), body as unknown as Record<string, unknown>);
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
    return this.orgService.updateMemberRole(orgId, userId, await this.ssoAuth(req), body as unknown as Record<string, unknown>);
  }

  @Delete(':orgId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member from the organisation (admin only)' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiParam({ name: 'userId', description: 'SSO user ID' })
  async removeMember(@Param('orgId') orgId: string, @Param('userId') userId: string, @Req() req: Request) {
    return this.orgService.removeMember(orgId, userId, await this.ssoAuth(req));
  }

  @Get(':orgId/invitations')
  @ApiOperation({ summary: 'List pending invitations for an organisation' })
  @ApiParam({ name: 'orgId', description: 'SSO organisation ID' })
  @ApiWrappedOkResponse({ dataDto: InvitationDto, isArray: true, description: 'Pending invitations' })
  async listInvitations(@Param('orgId') orgId: string, @Req() req: Request) {
    return this.orgService.listInvitations(orgId, await this.ssoAuth(req));
  }
}
