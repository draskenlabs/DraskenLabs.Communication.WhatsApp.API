import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { UserService } from './user.service';
import { UserWhatsappService } from './user-whatsapp.service';
import { UserController } from './user.controller';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthMiddleware } from './middleware/auth.middleware';
import { SsoService } from 'src/auth/sso.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
    }),
  ],
  // SsoService is stateless (config + axios). AuthModule already imports
  // UserModule, so importing it back would be circular — provide it here.
  providers: [UserService, UserWhatsappService, SsoService],
  controllers: [UserController],
  exports: [UserService, UserWhatsappService, JwtModule, SsoService],
})
export class UserModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .exclude({ path: 'user/test-token', method: RequestMethod.POST })
      .forRoutes(UserController);
  }
}
