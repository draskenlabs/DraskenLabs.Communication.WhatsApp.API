import { MiddlewareConsumer, Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UserModule } from 'src/user/user.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

@Module({
  imports: [PrismaModule, UserModule],
  controllers: [SearchController],
  providers: [SearchService, AuthMiddleware],
})
export class SearchModule {
  configure(consumer: MiddlewareConsumer) {
    // Console-only, like analytics: a search reads across every domain in the
    // organisation, which is wider than the per-number send an API key buys.
    consumer.apply(AuthMiddleware).forRoutes(SearchController);
  }
}
