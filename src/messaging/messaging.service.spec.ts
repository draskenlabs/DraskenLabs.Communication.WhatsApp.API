import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { BillingService } from 'src/billing/billing.service';
import { billingServiceDouble } from 'src/billing/billing.test-doubles';
import { RedisService } from 'src/redis/redis.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { ContactsService } from 'src/contacts/contacts.service';
import { MessageTypeEnum } from './dto/send-message.dto';
import axios from 'axios';
import { MailNotifications } from 'src/mail/mail.notifications';
import { MailService } from 'src/mail/mail.service';
import { mailNotificationsDouble, mailServiceDouble } from 'src/mail/mail.test-doubles';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  message: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
  },
  wabaPhoneNumber: { findMany: jest.fn() },
  $transaction: jest.fn(),
};
const mockRedis = { getPhoneCache: jest.fn() };
const mockEncryption = { decrypt: jest.fn().mockReturnValue('plain_token') };
const mockContacts = { isOptedOut: jest.fn().mockResolvedValue(false) };

const mockMailNotifications = mailNotificationsDouble();
const mockBilling = billingServiceDouble();
const mockMail = mailServiceDouble();

describe('MessagingService', () => {
  let service: MessagingService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        { provide: MailService, useValue: mockMail },
        MessagingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: BillingService, useValue: mockBilling },
        { provide: RedisService, useValue: mockRedis },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: ContactsService, useValue: mockContacts },
      ],
    }).compile();
    service = module.get<MessagingService>(MessagingService);
  });

  describe('sendMessage', () => {
    const dto: any = {
      phoneNumberId: 'p1',
      to: '447911111111',
      type: MessageTypeEnum.text,
      text: 'Hello',
    };

    it('throws NotFoundException if phone not in cache', async () => {
      mockRedis.getPhoneCache.mockResolvedValue(null);
      await expect(service.sendMessage(1, 'sso_org_1', dto)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException if phone belongs to different user', async () => {
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 99, wabaId: 'w1', accessToken: 'enc' });
      await expect(service.sendMessage(1, 'sso_org_1', dto)).rejects.toThrow(ForbiddenException);
    });

    it('refuses a number belonging to another WABA than the key is scoped to', async () => {
      // The number decides the WABA, so an unchecked key issued for one
      // account could otherwise send from every number the org owns.
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w2', accessToken: 'enc' });

      await expect(service.sendMessage(1, 'sso_org_1', dto, 'w1')).rejects.toThrow(/scoped to w1/);
      expect(mockPrisma.message.create).not.toHaveBeenCalled();
    });

    it('sends when the number belongs to the key’s own WABA', async () => {
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc' });
      mockContacts.isOptedOut.mockResolvedValue(false);
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.ok' }] } });
      mockPrisma.message.create.mockResolvedValue({
        id: 7, metaMessageId: 'wamid.ok', phoneNumberId: 'p1', to: '447911111111',
        type: 'text', status: 'sent', createdAt: new Date(),
      });

      const result = await service.sendMessage(1, 'sso_org_1', dto, 'w1');

      expect(result.id).toBe(7);
    });

    it('refuses a send on an account with no subscription, console included', async () => {
      // The console reaches here without passing the API-key paywall, and must
      // not be a free way to do the thing being sold.
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc' });
      mockBilling.requireAccess.mockRejectedValueOnce(
        new HttpException('no subscription', HttpStatus.PAYMENT_REQUIRED),
      );

      await expect(service.sendMessage(1, 'sso_org_1', dto)).rejects.toMatchObject({
        status: 402,
      });
      expect(mockBilling.requireAccess).toHaveBeenCalledWith('w1');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('throws BadRequestException if recipient has opted out', async () => {
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc' });
      mockContacts.isOptedOut.mockResolvedValueOnce(true);
      await expect(service.sendMessage(1, 'sso_org_1', dto)).rejects.toThrow(BadRequestException);
    });

    it('sends text message and persists to DB', async () => {
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc' });
      mockContacts.isOptedOut.mockResolvedValue(false);
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.abc' }] } });
      mockPrisma.message.create.mockResolvedValue({
        id: 1, metaMessageId: 'wamid.abc', phoneNumberId: 'p1', to: '447911111111',
        type: 'text', status: 'sent', createdAt: new Date(),
      });

      const result = await service.sendMessage(1, 'sso_org_1', dto);
      expect(result.metaMessageId).toBe('wamid.abc');
      expect(mockPrisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'text', ssoOrgId: 'sso_org_1' }) }),
      );
    });

    it('sends template message with correct Meta payload', async () => {
      const templateDto: any = {
        phoneNumberId: 'p1', to: '447911111111',
        type: MessageTypeEnum.template,
        templateName: 'hello_world', templateLanguage: 'en_US',
      };
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc' });
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.t1' }] } });
      mockPrisma.message.create.mockResolvedValue({
        id: 2, metaMessageId: 'wamid.t1', phoneNumberId: 'p1', to: '447911111111',
        type: 'template', status: 'sent', createdAt: new Date(),
      });

      await service.sendMessage(1, 'sso_org_1', templateDto);

      const postedPayload = (mockedAxios.post as jest.Mock).mock.calls[0][1];
      expect(postedPayload.template.name).toBe('hello_world');
      expect(postedPayload.template.language.code).toBe('en_US');
    });

    it('translates a Meta 400 into a BadRequestException with the Meta message', async () => {
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc' });
      mockContacts.isOptedOut.mockResolvedValue(false);
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: { data: { error: { message: 'Invalid parameter', code: 100, fbtrace_id: 'ABC' } } },
      });

      await expect(service.sendMessage(1, 'sso_org_1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.sendMessage(1, 'sso_org_1', dto)).rejects.toThrow('Invalid parameter');
      expect(mockPrisma.message.create).not.toHaveBeenCalled();
    });

    it('sends location message with correct Meta payload', async () => {
      const locationDto: any = {
        phoneNumberId: 'p1', to: '447911111111',
        type: MessageTypeEnum.location,
        latitude: 37.4847, longitude: -122.1477,
        locationName: 'Meta HQ', locationAddress: '1 Hacker Way',
      };
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc' });
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.l1' }] } });
      mockPrisma.message.create.mockResolvedValue({
        id: 3, metaMessageId: 'wamid.l1', phoneNumberId: 'p1', to: '447911111111',
        type: 'location', status: 'sent', createdAt: new Date(),
      });

      await service.sendMessage(1, 'sso_org_1', locationDto);

      const postedPayload = (mockedAxios.post as jest.Mock).mock.calls[0][1];
      expect(postedPayload.type).toBe('location');
      expect(postedPayload.location).toEqual({
        latitude: 37.4847, longitude: -122.1477, name: 'Meta HQ', address: '1 Hacker Way',
      });
    });

    it('sends interactive reply-button message with correct Meta payload', async () => {
      const interactiveDto: any = {
        phoneNumberId: 'p1', to: '447911111111',
        type: MessageTypeEnum.interactive,
        interactiveType: 'button',
        interactiveBodyText: 'Confirm your order?',
        interactiveFooterText: 'Drasken Labs',
        interactiveButtons: [
          { id: 'yes', title: 'Yes' },
          { id: 'no', title: 'No' },
        ],
      };
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc' });
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.i1' }] } });
      mockPrisma.message.create.mockResolvedValue({
        id: 4, metaMessageId: 'wamid.i1', phoneNumberId: 'p1', to: '447911111111',
        type: 'interactive', status: 'sent', createdAt: new Date(),
      });

      await service.sendMessage(1, 'sso_org_1', interactiveDto);

      const postedPayload = (mockedAxios.post as jest.Mock).mock.calls[0][1];
      expect(postedPayload.type).toBe('interactive');
      expect(postedPayload.interactive.type).toBe('button');
      expect(postedPayload.interactive.body).toEqual({ text: 'Confirm your order?' });
      expect(postedPayload.interactive.footer).toEqual({ text: 'Drasken Labs' });
      expect(postedPayload.interactive.action.buttons).toEqual([
        { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
        { type: 'reply', reply: { id: 'no', title: 'No' } },
      ]);
    });

    it('sends interactive cta_url message with correct Meta payload', async () => {
      const ctaDto: any = {
        phoneNumberId: 'p1', to: '447911111111',
        type: MessageTypeEnum.interactive,
        interactiveType: 'cta_url',
        interactiveBodyText: 'View your invoice',
        interactiveCtaDisplayText: 'Open invoice',
        interactiveCtaUrl: 'https://example.com/i/48210',
      };
      mockRedis.getPhoneCache.mockResolvedValue({ userId: 1, wabaId: 'w1', accessToken: 'enc' });
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.c1' }] } });
      mockPrisma.message.create.mockResolvedValue({
        id: 5, metaMessageId: 'wamid.c1', phoneNumberId: 'p1', to: '447911111111',
        type: 'interactive', status: 'sent', createdAt: new Date(),
      });

      await service.sendMessage(1, 'sso_org_1', ctaDto);

      const postedPayload = (mockedAxios.post as jest.Mock).mock.calls[0][1];
      expect(postedPayload.interactive.type).toBe('cta_url');
      expect(postedPayload.interactive.action).toEqual({
        name: 'cta_url',
        parameters: { display_text: 'Open invoice', url: 'https://example.com/i/48210' },
      });
    });
  });

  describe('findAll', () => {
    it('returns every message scoped to org when unpaginated', async () => {
      mockPrisma.message.findMany.mockResolvedValue([
        { id: 1, metaMessageId: 'w1', phoneNumberId: 'p1', to: '111', type: 'text', status: 'sent', createdAt: new Date(), updatedAt: new Date() },
      ]);
      const result = await service.findAll('sso_org_1');
      expect(mockPrisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ssoOrgId: 'sso_org_1' } }));
      expect(result.data).toHaveLength(1);
      expect(result.meta).toBeUndefined();
    });

    it('paginates and returns meta when page/limit supplied', async () => {
      mockPrisma.$transaction.mockResolvedValue([
        [{ id: 2, phoneNumberId: 'p1', to: '222', type: 'text', status: 'sent', createdAt: new Date(), updatedAt: new Date() }],
        41,
      ]);
      const result = await service.findAll('sso_org_1', { page: 2, limit: 20 });
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({ total: 41, totalPages: 3, page: 2, limit: 20 });
    });

    it('narrows the list to the numbers of a scoped key’s WABA', async () => {
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([
        { phoneNumberId: 'p1' },
        { phoneNumberId: 'p2' },
      ]);
      mockPrisma.message.findMany.mockResolvedValue([]);

      await service.findAll('sso_org_1', {}, 'w1');

      expect(mockPrisma.wabaPhoneNumber.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { wabaId: 'w1' } }),
      );
      expect(mockPrisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ssoOrgId: 'sso_org_1', phoneNumberId: { in: ['p1', 'p2'] } },
        }),
      );
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException if message not in org', async () => {
      mockPrisma.message.findUnique.mockResolvedValue({ id: 1, ssoOrgId: 'sso_org_99' });
      await expect(service.findOne('sso_org_1', 1)).rejects.toThrow(NotFoundException);
    });

    it('hides a message sent from another WABA than the key is scoped to', async () => {
      // Not found rather than forbidden — the existence of traffic on another
      // of the org's accounts is not this key's business either.
      mockPrisma.message.findUnique.mockResolvedValue({
        id: 1, ssoOrgId: 'sso_org_1', phoneNumberId: 'p9',
      });
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([{ phoneNumberId: 'p1' }]);

      await expect(service.findOne('sso_org_1', 1, 'w1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('analytics', () => {
    it('counts only the scoped WABA’s numbers', async () => {
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([{ phoneNumberId: 'p1' }]);
      mockPrisma.message.findMany.mockResolvedValue([]);

      await service.analytics('sso_org_1', 14, 'w1');

      expect(mockPrisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ phoneNumberId: { in: ['p1'] } }),
        }),
      );
    });
  });
});
