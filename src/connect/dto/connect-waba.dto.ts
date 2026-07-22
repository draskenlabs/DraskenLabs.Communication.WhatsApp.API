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
