import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WabaPhoneNumberService } from './waba-phone-number.service';
import { Request } from 'express';
import { ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';
import { WabaPhoneNumberResponseDto } from './dto/waba-phone-number-response.dto';
import { RegisterPhoneNumberDto } from './dto/register-phone-number.dto';

@ApiTags('WABA Phone Numbers')
@Controller('wabas/:wabaId/phone-numbers')
export class WabaPhoneNumberController {
  constructor(private readonly phoneNumberService: WabaPhoneNumberService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all phone numbers for a specific WABA' })
  @ApiWrappedOkResponse({
    dataDto: WabaPhoneNumberResponseDto,
    isArray: true,
    description: 'List of WABA phone numbers',
  })
  async findAll(
    @Param('wabaId') wabaId: string,
    @Req() req: Request,
  ): Promise<WabaPhoneNumberResponseDto[]> {
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    return this.phoneNumberService.findAllByWabaId(orgId, wabaId);
  }

  @Post('sync')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sync phone numbers from Meta Graph API for a specific WABA',
  })
  @ApiWrappedOkResponse({
    dataDto: WabaPhoneNumberResponseDto,
    isArray: true,
    description: 'List of synced WABA phone numbers',
  })
  async sync(
    @Param('wabaId') wabaId: string,
    @Req() req: Request,
  ): Promise<WabaPhoneNumberResponseDto[]> {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedException('User not found in context');
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    return this.phoneNumberService.syncPhoneNumbers(user.id, orgId, wabaId);
  }

  @Post(':phoneNumberId/register')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Register a phone number on the WhatsApp Cloud API',
    description:
      'Registers the number with Meta using a 6-digit PIN so it can send messages. Required once before a verified number can be used.',
  })
  @ApiWrappedOkResponse({
    dataDto: WabaPhoneNumberResponseDto,
    description: 'Registered phone number',
  })
  async register(
    @Param('wabaId') wabaId: string,
    @Param('phoneNumberId') phoneNumberId: string,
    @Body() dto: RegisterPhoneNumberDto,
    @Req() req: Request,
  ): Promise<WabaPhoneNumberResponseDto> {
    const user = (req as any).user;
    if (!user) throw new UnauthorizedException('User not found in context');
    const ssoOrgId = (req as any).orgId;
    if (!ssoOrgId)
      throw new UnauthorizedException('Organisation not found in context');
    return this.phoneNumberService.registerPhoneNumber(
      user.id,
      ssoOrgId,
      wabaId,
      phoneNumberId,
      dto.pin,
    );
  }
}
