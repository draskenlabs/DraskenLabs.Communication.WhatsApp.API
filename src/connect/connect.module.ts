import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { ConnectController } from './connect.controller';
import { ConnectService } from './connect.service';
import { UserModule } from 'src/user/user.module';
import { WabaModule } from 'src/waba/waba.module';
import { WabaPhoneNumberModule } from 'src/waba-phone-number/waba-phone-number.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

@Module({
  imports: [UserModule, WabaModule, WabaPhoneNumberModule],
  controllers: [ConnectController],
  providers: [ConnectService],
})
export class ConnectModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'connect', method: RequestMethod.POST },
        { path: 'connect/manual', method: RequestMethod.POST },
      );
  }
}
