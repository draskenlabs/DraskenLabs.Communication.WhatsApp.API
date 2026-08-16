import { Module } from '@nestjs/common';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { UserModule } from 'src/user/user.module';
import { PlansModule } from 'src/plans/plans.module';

@Module({
  imports: [UserModule, PlansModule],
  controllers: [OrgController],
  providers: [OrgService],
})
export class OrgModule {}
