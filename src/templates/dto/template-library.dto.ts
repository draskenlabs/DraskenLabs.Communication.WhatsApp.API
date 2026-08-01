import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Meta's Template Library — pre-written, pre-approved utility templates a
 * business can adopt instead of drafting and waiting for review.
 *
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-library
 */

/** Filters accepted by `GET /message_template_library`. */
export class ListTemplateLibraryDto {
  @ApiPropertyOptional({ description: 'Free-text substring, e.g. "payment"' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description:
      'ACCOUNT_UPDATE | CUSTOMER_FEEDBACK | ORDER_MANAGEMENT | PAYMENTS',
  })
  @IsOptional()
  @IsString()
  topic?: string;

  @ApiPropertyOptional({ description: 'Use case, e.g. ORDER_CONFIRMATION' })
  @IsOptional()
  @IsString()
  usecase?: string;

  @ApiPropertyOptional({ description: 'E_COMMERCE | FINANCIAL_SERVICES' })
  @IsOptional()
  @IsString()
  industry?: string;

  @ApiPropertyOptional({ description: 'Locale code, e.g. en_US' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({
    description:
      'UTILITY | MARKETING | AUTHENTICATION. Sent to Meta and also applied to ' +
      'what it returns, so the filter holds whether or not Meta narrows the ' +
      'query itself.',
  })
  @IsOptional()
  @IsString()
  category?: string;
}

/** One template as Meta's library returns it. */
export class LibraryTemplateDto {
  @ApiProperty() id: string;
  @ApiProperty({
    description: 'The library name to pass back when adopting it',
  })
  name: string;
  @ApiProperty() language: string;
  @ApiProperty({
    description:
      "The entry's category as Meta publishes it — mostly UTILITY, but the " +
      'library now carries others too',
    example: 'UTILITY',
  })
  category: string;

  @ApiPropertyOptional() topic?: string;
  @ApiPropertyOptional() usecase?: string;
  @ApiPropertyOptional({ type: [String] }) industry?: string[];

  @ApiPropertyOptional({
    description: 'Fixed header text, when the template has one',
  })
  header?: string;

  @ApiProperty({
    description:
      'Body text with {{n}} placeholders. Fixed — it cannot be edited',
  })
  body: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Meta's sample values, one per placeholder",
  })
  bodyParams?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Accepted value type per placeholder — TEXT, AMOUNT, DATE, PHONE_NUMBER, EMAIL, ADDRESS, NUMBER',
  })
  bodyParamTypes?: string[];

  @ApiPropertyOptional({
    description: 'Buttons the template ships with, some needing your input',
  })
  buttons?: Record<string, unknown>[];
}

/** `url` input for a URL button — Meta fixes the text, you supply the target. */
export class LibraryButtonUrlDto {
  @ApiProperty({
    description: 'Target URL, may contain a {{1}} suffix placeholder',
  })
  @IsString()
  @IsNotEmpty()
  base_url: string;

  @ApiPropertyOptional({
    description: 'Example of the URL with the placeholder filled in',
  })
  @IsOptional()
  @IsString()
  url_suffix_example?: string;
}

/** One entry of `library_template_button_inputs`. */
export class LibraryButtonInputDto {
  @ApiProperty({
    description:
      'QUICK_REPLY | URL | PHONE_NUMBER | OTP | MPM | CATALOG | FLOW | VOICE_CALL | APP',
  })
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiPropertyOptional({
    description: 'E.164 number for a PHONE_NUMBER button',
  })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({ type: LibraryButtonUrlDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LibraryButtonUrlDto)
  url?: LibraryButtonUrlDto;

  @ApiPropertyOptional({ description: 'COPY_CODE | ONE_TAP | ZERO_TAP' })
  @IsOptional()
  @IsString()
  otp_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  zero_tap_terms_accepted?: boolean;
}

/** Body for adopting a library template into your own WABA. */
export class CreateFromLibraryDto {
  @ApiProperty({
    description: 'Your name for the template — lowercase, underscores',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  name: string;

  @ApiProperty({
    description:
      'Locale code, e.g. en_US. Must be one the library template offers',
  })
  @IsString()
  @IsNotEmpty()
  language: string;

  @ApiProperty({
    description: 'Exact `name` of the library template being adopted',
  })
  @IsString()
  @IsNotEmpty()
  libraryTemplateName: string;

  @ApiPropertyOptional({
    type: [LibraryButtonInputDto],
    description:
      'Values for buttons that need them — a phone number to call, a URL to open',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LibraryButtonInputDto)
  libraryTemplateButtonInputs?: LibraryButtonInputDto[];

  @ApiPropertyOptional({
    description:
      'Optional body switches, e.g. add_contact_number, add_track_package_link, code_expiration_minutes',
  })
  @IsOptional()
  @IsObject()
  libraryTemplateBodyInputs?: Record<string, unknown>;
}
