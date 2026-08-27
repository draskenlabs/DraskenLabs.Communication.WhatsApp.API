import { Global, Module } from '@nestjs/common';
import { OrganisationSettingsService } from './organisation-settings.service';
import { PrismaModule } from 'src/prisma/prisma.module';

/**
 * Global because the question it answers — who pays for this organisation — is
 * asked by the paywall, the limits and the billing sweep alike, and threading
 * an import through every one of them buys nothing.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [OrganisationSettingsService],
  exports: [OrganisationSettingsService],
})
export class OrganisationSettingsModule {}
