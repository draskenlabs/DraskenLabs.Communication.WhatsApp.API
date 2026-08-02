import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { ConnectController } from './connect.controller';
import { ConnectService } from './connect.service';
import { UserModule } from 'src/user/user.module';
import { WabaModule } from 'src/waba/waba.module';
import { ProvisioningModule } from 'src/provisioning/provisioning.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

@Module({
  imports: [UserModule, WabaModule, ProvisioningModule],
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
