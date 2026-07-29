import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ConnectWhatsAppRequestDTO {
  @ApiProperty({ description: 'OAuth code received from Meta Embedded Signup' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ description: 'WhatsApp Business Account ID' })
  @IsString()
  @IsNotEmpty()
  wabaId: string;

  @ApiPropertyOptional({
    description: 'Meta Business ID. Optional — derived from the WABA (owner_business_info) when omitted.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  businessId?: string;
}

export class ManualConnectRequestDTO {
  @ApiProperty({ description: 'WhatsApp Business Account ID (e.g. from API Setup / test number)' })
  @IsString()
  @IsNotEmpty()
  wabaId: string;

  @ApiProperty({ description: 'Access token for the WABA (temporary test token is fine)' })
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @ApiPropertyOptional({ description: 'Meta Business ID. Derived from the WABA when omitted.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  businessId?: string;

  @ApiPropertyOptional({ description: 'Display name for the WABA when metadata cannot be fetched.' })
  @IsOptional()
  @IsString()
  name?: string;
}

export class ConnectedPhoneNumberDTO {
  @ApiProperty() phoneNumberId: string;
  @ApiProperty() displayPhoneNumber: string;
  @ApiProperty() verifiedName: string;
}

export class ConnectWhatsAppResponseDTO {
  @ApiProperty() wabaId: string;
  @ApiProperty() businessId: string;

  @ApiProperty({ type: ConnectedPhoneNumberDTO, isArray: true })
  phoneNumbers: ConnectedPhoneNumberDTO[];
}
