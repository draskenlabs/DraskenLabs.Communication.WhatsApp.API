import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SsoService } from './sso.service';
import { UserModule } from 'src/user/user.module';
import { OrgDirectoryModule } from 'src/org/org-directory.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

@Module({
  imports: [UserModule, OrgDirectoryModule],
  controllers: [AuthController],
  providers: [AuthService, SsoService, AuthMiddleware],
})
export class AuthModule {
  configure(consumer: MiddlewareConsumer) {
    // `callback` has no token yet, and `refresh` is reached precisely when the
    // one it had has expired. Everything else on this controller authenticates
    // like the rest of the API.
    consumer
      .apply(AuthMiddleware)
      .exclude(
        { path: 'auth/callback', method: RequestMethod.POST },
        { path: 'auth/refresh', method: RequestMethod.POST },
      )
      .forRoutes(AuthController);
  }
}
