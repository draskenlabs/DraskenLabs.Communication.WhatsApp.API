import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Operator request: mark an organisation an agency, or stop being one. */
export class ConvertAgencyDto {
  @ApiProperty({ description: 'The SSO organisation to convert' })
  @IsString()
  @IsNotEmpty()
  ssoOrgId: string;

  @ApiPropertyOptional({
    description: 'False to demote an agency back to an ordinary organisation.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isAgency?: boolean;

  @ApiPropertyOptional({
    description: 'Id of the operator making the change, recorded on the row.',
  })
  @IsOptional()
  @IsInt()
  convertedBy?: number;
}

/** Operator request: put a client organisation under an agency. */
export class AttachClientDto {
  @ApiProperty({ description: 'The agency that will pay for this client' })
  @IsString()
  @IsNotEmpty()
  agencyOrgId: string;

  @ApiProperty({ description: 'The SSO organisation to take on as a client' })
  @IsString()
  @IsNotEmpty()
  ssoOrgId: string;

  @ApiPropertyOptional({ description: 'What the agency calls this client' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientName?: string;
}

/** What an agency may change about its own client: the label it gave it. */
export class RenameClientDto {
  @ApiProperty({ description: 'What the agency calls this client' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  clientName: string;
}

export class ClientSummaryDto {
  @ApiProperty() ssoOrgId: string;
  @ApiProperty({ description: 'The agency’s label, or the best name we know' })
  name: string;
  @ApiProperty() wabas: number;
  @ApiProperty() phoneNumbers: number;
  @ApiProperty() contacts: number;
  @ApiProperty({ description: 'Messages sent since the first of this month' })
  messagesThisMonth: number;
  @ApiProperty() addedAt: Date;
}

export class AgencyUsageDto {
  @ApiProperty({ description: 'Clients on the roster' }) clients: number;
  @ApiProperty() wabas: number;
  @ApiProperty() phoneNumbers: number;

  @ApiPropertyOptional({
    description: 'Clients the plan includes, or null when it names no number',
    nullable: true,
  })
  includedClients: number | null;

  @ApiPropertyOptional({
    description: 'WABAs the plan includes, or null when it names no number',
    nullable: true,
  })
  includedWabas: number | null;

  @ApiPropertyOptional({ nullable: true })
  planName: string | null;
}

export class AgencyRosterDto {
  @ApiProperty({ type: ClientSummaryDto, isArray: true })
  clients: ClientSummaryDto[];

  @ApiProperty({ type: AgencyUsageDto })
  totals: AgencyUsageDto;
}
