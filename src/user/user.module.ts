import { Module, MiddlewareConsumer } from '@nestjs/common';
import { UserService } from './user.service';
import { UserWhatsappService } from './user-whatsapp.service';
import { UserController } from './user.controller';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthMiddleware } from './middleware/auth.middleware';
import { SsoService } from 'src/auth/sso.service';
import { SsoTokenService } from 'src/auth/sso-token.service';
import { OrgAccessService } from 'src/auth/org-access.service';
import { OrgDirectoryModule } from 'src/org/org-directory.module';

@Module({
  imports: [
    OrgDirectoryModule,
    // Nothing signs an access token here any more — the SSO's is the only one
    // in play. `JwtModule` stays for what still needs a signature of our own,
    // such as the HMAC on an unsubscribe link.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  // The SSO services are stateless (config, axios, a cached key ring).
  // AuthModule already imports UserModule, so importing it back would be
  // circular — provide them here and export them for everything that
  // authenticates.
  providers: [
    UserService,
    UserWhatsappService,
    SsoService,
    SsoTokenService,
    OrgAccessService,
  ],
  controllers: [UserController],
  exports: [
    UserService,
    UserWhatsappService,
    JwtModule,
    SsoService,
    SsoTokenService,
    OrgAccessService,
  ],
})
export class UserModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(UserController);
  }
}
