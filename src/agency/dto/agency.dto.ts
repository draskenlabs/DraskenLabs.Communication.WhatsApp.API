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

/** An agency taking on a client it creates itself. */
export class CreateClientDto {
  @ApiProperty({ description: 'What the client organisation is called' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiProperty({
    description:
      'The plan to put it on. A published tier, or one written privately ' +
      'for this agency.',
  })
  @IsString()
  @MaxLength(60)
  planCode: string;
}

/** What an agency is told after taking a client on. */
export class ClientSubscribedDto {
  @ApiProperty() ssoOrgId: string;
  @ApiProperty() name: string;
  @ApiProperty() planCode: string;
  @ApiProperty() planName: string;
  @ApiProperty() status: string;
  @ApiProperty({ nullable: true }) currentEnd: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'Set when this was the first client on the plan, so the mandate ' +
      'covering it still has to be authorised. Null when an existing mandate ' +
      'simply grew by one.',
  })
  authorisation: { subscriptionId: string; shortUrl: string | null } | null;
}

/** One mandate an agency holds, and what it covers. */
export class AgencyMandateDto {
  @ApiProperty() planCode: string;
  @ApiProperty() planName: string;
  @ApiProperty({ description: 'Clients on this plan' }) clients: number;
  @ApiProperty({ nullable: true, description: 'Per client, in paise' })
  pricePerClient: number | null;
  @ApiProperty({ nullable: true, description: 'Clients times the price' })
  monthly: number | null;
  @ApiProperty() currency: string;
  @ApiProperty() status: string;
  @ApiProperty({ nullable: true }) currentEnd: Date | null;
  @ApiProperty() cancelAtCycleEnd: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Where to authorise it, while it is still waiting to be',
  })
  authorisationUrl: string | null;
}
