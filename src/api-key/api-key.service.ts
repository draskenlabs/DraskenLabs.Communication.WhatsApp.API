import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { RedisService } from 'src/redis/redis.service';
import * as crypto from 'crypto';
import { CreateApiKeyDto, ApiKeyResponseDto } from './dto/api-key.dto';

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly mail: MailNotifications,
    private readonly redisService: RedisService,
  ) {}

  async createApiKey(userId: number, ssoOrgId: string, dto: CreateApiKeyDto): Promise<ApiKeyResponseDto> {
    const accessKey = `ak_${crypto.randomBytes(12).toString('hex')}`;
    const secretKey = `sk_${crypto.randomBytes(24).toString('hex')}`;
    const encryptedSecretKey = this.encryptionService.encrypt(secretKey);

    await this.prisma.userApiKey.create({
      data: { userId, ssoOrgId, accessKey, secretKey: encryptedSecretKey },
    });

    await this.redisService.setApiKeyCache(accessKey, userId, ssoOrgId, encryptedSecretKey);

    // The secret is shown once in the console and never emailed; this is the
    // alert that catches a key somebody else created.
    void this.mail.apiKeyCreated(userId, accessKey);

    return { accessKey, secretKey };
  }

  async findAllByOrgId(ssoOrgId: string) {
    return this.prisma.userApiKey.findMany({
      where: { ssoOrgId },
      select: { id: true, accessKey: true, status: true, createdAt: true },
    });
  }

  async revokeApiKey(userId: number, keyId: number): Promise<void> {
    const key = await this.prisma.userApiKey.findUnique({ where: { id: keyId } });

    if (!key || key.userId !== userId) {
      throw new NotFoundException('API key not found');
    }

    await this.prisma.userApiKey.update({
      where: { id: keyId },
      data: { status: false },
    });

    await this.redisService.deleteApiKeyCache(key.accessKey);

    void this.mail.apiKeyRevoked(userId, key.accessKey);
  }
}
