import { Module } from '@nestjs/common';
import { OrgDirectoryService } from './org-directory.service';

/**
 * On its own, and deliberately dependency-light: auth fills it in, mail reads
 * it, and neither should have to import the other.
 */
@Module({
  providers: [OrgDirectoryService],
  exports: [OrgDirectoryService],
})
export class OrgDirectoryModule {}
