import { Module, MiddlewareConsumer } from '@nestjs/common';
import { WabaPhoneNumberService } from './waba-phone-number.service';
import { WabaPhoneNumberController } from './waba-phone-number.controller';
import { BillingModule } from 'src/billing/billing.module';
import { UserModule } from 'src/user/user.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

@Module({
  imports: [UserModule, BillingModule],
  providers: [WabaPhoneNumberService],
  controllers: [WabaPhoneNumberController],
  exports: [WabaPhoneNumberService],
})
export class WabaPhoneNumberModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(WabaPhoneNumberController);
  }
}
