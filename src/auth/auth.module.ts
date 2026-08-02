import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SsoService } from './sso.service';
import { UserModule } from 'src/user/user.module';
import { OrgDirectoryModule } from 'src/org/org-directory.module';

@Module({
  imports: [UserModule, OrgDirectoryModule],
  controllers: [AuthController],
  providers: [AuthService, SsoService],
})
export class AuthModule {}
