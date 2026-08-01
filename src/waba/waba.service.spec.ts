import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WabaService } from './waba.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { RedisService } from 'src/redis/redis.service';
import axios from 'axios';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  waba: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
  wabaOrganisation: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
  },
  userWhatsapp: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    delete: jest.fn(),
  },
  wabaPhoneNumber: { findMany: jest.fn() },
  $transaction: jest.fn(),
};

const mockEncryption = { decrypt: jest.fn().mockReturnValue('plain_token') };
const mockRedis = { invalidatePhoneCache: jest.fn() };

const mockMailNotifications = mailNotificationsDouble();

describe('WabaService', () => {
  let service: WabaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        WabaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<WabaService>(WabaService);
  });

  describe('findAllByOrgId', () => {
    it('flags which WABAs the caller still has a connection to', async () => {
      // A disconnect keeps the WABA row for audit, so "listed" and "usable"
      // are different things — the console needs to be able to tell them apart.
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'w1' },
        { wabaId: 'w2' },
      ]);
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([{ wabaId: 'w1' }]);

      await expect(service.findAllByOrgId('sso_org_1', 7)).resolves.toEqual([
        { wabaId: 'w1', connected: true },
        { wabaId: 'w2', connected: false },
      ]);
      expect(mockPrisma.waba.findMany).toHaveBeenCalledWith({
        where: { WabaOrganisation: { some: { ssoOrgId: 'sso_org_1' } } },
      });
      expect(mockPrisma.userWhatsapp.findMany).toHaveBeenCalledWith({
        where: { wabaId: { in: ['w1', 'w2'] }, userId: 7 },
        select: { wabaId: true },
      });
    });

    it('does not query connections when the org has no WABAs', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([]);
      await expect(service.findAllByOrgId('sso_org_1', 7)).resolves.toEqual([]);
      expect(mockPrisma.userWhatsapp.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findByWabaId', () => {
    it('returns WABA when found', async () => {
      const waba = { wabaId: 'w1', ssoOrgId: 'sso_org_1' };
      mockPrisma.waba.findFirst.mockResolvedValue(waba);
      await expect(service.findByWabaId('sso_org_1', 'w1')).resolves.toEqual(waba);
    });

    it('throws NotFoundException when not found', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      const { NotFoundException } = await import('@nestjs/common');
      await expect(service.findByWabaId('sso_org_1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createOrUpdateWaba', () => {
    const data = { wabaId: 'w1', userId: 1, ssoOrgId: 'sso_org_1', name: 'Test' };

    it('creates a new WABA when none exists', async () => {
      mockPrisma.wabaOrganisation.findUnique.mockResolvedValue(null);
      mockPrisma.waba.upsert.mockResolvedValue({ ...data });
      mockPrisma.wabaOrganisation.upsert.mockResolvedValue({});

      await expect(service.createOrUpdateWaba(data)).resolves.toEqual({ ...data });
      expect(mockPrisma.waba.upsert).toHaveBeenCalled();
      expect(mockPrisma.wabaOrganisation.upsert).toHaveBeenCalled();
    });

    it('updates WABA when requester is the owner', async () => {
      mockPrisma.wabaOrganisation.findUnique.mockResolvedValue({
        wabaId: 'w1',
        ssoOrgId: 'sso_org_1',
        userId: 1,
      });
      mockPrisma.waba.upsert.mockResolvedValue({ ...data });
      mockPrisma.wabaOrganisation.upsert.mockResolvedValue({});

      await expect(service.createOrUpdateWaba(data)).resolves.toBeDefined();
    });

    it('connects the same account into a second organisation', async () => {
      // The account is Meta's and shared; what is per organisation is the
      // membership. This used to update the other organisation's row instead.
      mockPrisma.wabaOrganisation.findUnique.mockResolvedValue(null);
      mockPrisma.waba.upsert.mockResolvedValue({ ...data, ssoOrgId: 'sso_org_first' });
      mockPrisma.wabaOrganisation.upsert.mockResolvedValue({});

      await expect(
        service.createOrUpdateWaba({ ...data, ssoOrgId: 'sso_org_second' }),
      ).resolves.toBeDefined();

      expect(mockPrisma.wabaOrganisation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ wabaId: 'w1', ssoOrgId: 'sso_org_second' }),
        }),
      );
    });

    it('refuses when someone else in the same organisation connected it', async () => {
      mockPrisma.wabaOrganisation.findUnique.mockResolvedValue({
        wabaId: 'w1',
        ssoOrgId: 'sso_org_1',
        userId: 99,
      });

      const { ForbiddenException } = await import('@nestjs/common');
      await expect(service.createOrUpdateWaba(data)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.waba.upsert).not.toHaveBeenCalled();
    });
  });

  describe('disconnectWaba', () => {
    it('throws NotFoundException if WABA not in org', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(service.disconnectWaba(1, 'sso_org_1', 'w1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException if user does not own the connection', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.userWhatsapp.findUnique.mockResolvedValue(null);
      await expect(service.disconnectWaba(1, 'sso_org_1', 'w1')).rejects.toThrow(ForbiddenException);
    });

    it('invalidates phone cache for all phone numbers and deletes connection', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.userWhatsapp.findUnique.mockResolvedValue({ userId: 1, wabaId: 'w1' });
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([
        { phoneNumberId: 'p1' },
        { phoneNumberId: 'p2' },
      ]);
      mockPrisma.userWhatsapp.delete.mockResolvedValue({});

      await service.disconnectWaba(1, 'sso_org_1', 'w1');

      expect(mockRedis.invalidatePhoneCache).toHaveBeenCalledWith('p1');
      expect(mockRedis.invalidatePhoneCache).toHaveBeenCalledWith('p2');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.userWhatsapp.delete).toHaveBeenCalledWith({
        where: { userId_wabaId: { userId: 1, wabaId: 'w1' } },
      });
      // The account leaves this organisation and stays in any other that has it.
      expect(mockPrisma.wabaOrganisation.deleteMany).toHaveBeenCalledWith({
        where: { wabaId: 'w1', ssoOrgId: 'sso_org_1' },
      });
    });

    it('works when WABA has no phone numbers', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.userWhatsapp.findUnique.mockResolvedValue({ userId: 1, wabaId: 'w1' });
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([]);
      mockPrisma.userWhatsapp.delete.mockResolvedValue({});

      await service.disconnectWaba(1, 'sso_org_1', 'w1');

      expect(mockRedis.invalidatePhoneCache).not.toHaveBeenCalled();
      expect(mockPrisma.userWhatsapp.delete).toHaveBeenCalled();
    });
  });

  describe('deleteWaba while shared', () => {
    it('refuses while another organisation still has the account', async () => {
      // Phone numbers, templates and inbound messages belong to the account,
      // not to one organisation's copy of it — erasing them would take the
      // other organisation's data with them.
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1', userId: 1 });
      mockPrisma.wabaOrganisation.count.mockResolvedValue(2);

      const { ConflictException } = await import('@nestjs/common');
      await expect(service.deleteWaba(1, 'sso_org_1', 'w1')).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('deleteWaba', () => {
    const tx = {
      messageTemplate: { deleteMany: jest.fn() },
      inboundMessage: { deleteMany: jest.fn() },
      webhookEvent: { deleteMany: jest.fn() },
      message: { deleteMany: jest.fn() },
      wabaPhoneNumber: { deleteMany: jest.fn() },
      userWhatsapp: { deleteMany: jest.fn() },
      waba: { delete: jest.fn() },
    };

    beforeEach(() => {
      for (const model of Object.values(tx)) {
        for (const fn of Object.values(model)) {
          fn.mockReset().mockResolvedValue({ count: 1 });
        }
      }
      mockPrisma.$transaction.mockImplementation(
        (fn: (t: typeof tx) => unknown) => fn(tx),
      );
      mockPrisma.waba.findFirst.mockResolvedValue({
        wabaId: 'w1',
        userId: 1,
        name: 'OneManPlay Games',
      });
      // The only organisation holding it: deleting is refused while shared.
      mockPrisma.wabaOrganisation.count.mockResolvedValue(1);
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([{ userId: 1 }]);
      mockPrisma.userWhatsapp.findUnique.mockResolvedValue({
        accessToken: 'enc',
      });
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([
        { phoneNumberId: 'p1' },
      ]);
      mockedAxios.delete = jest.fn().mockResolvedValue({ data: {} });
    });

    it('refuses an account belonging to another organisation', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(service.deleteWaba(1, 'sso_org_1', 'w1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses anyone but the person who connected it', async () => {
      // Ownership comes from the Waba row, not a connection — a disconnected
      // account has no connection left to check.
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1', userId: 9 });
      await expect(service.deleteWaba(1, 'sso_org_1', 'w1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('removes everything held about the account, in one transaction', async () => {
      const counts = await service.deleteWaba(1, 'sso_org_1', 'w1');

      expect(tx.messageTemplate.deleteMany).toHaveBeenCalledWith({
        where: { wabaId: 'w1' },
      });
      expect(tx.inboundMessage.deleteMany).toHaveBeenCalledWith({
        where: { wabaId: 'w1' },
      });
      expect(tx.webhookEvent.deleteMany).toHaveBeenCalledWith({
        where: { wabaId: 'w1' },
      });
      // Outbound messages carry a phone number, not a WABA.
      expect(tx.message.deleteMany).toHaveBeenCalledWith({
        where: { phoneNumberId: { in: ['p1'] } },
      });
      // Every member's connection, not just the caller's — one left behind
      // would hold the WABA in place by its foreign key.
      expect(tx.userWhatsapp.deleteMany).toHaveBeenCalledWith({
        where: { wabaId: 'w1' },
      });
      expect(tx.waba.delete).toHaveBeenCalledWith({ where: { wabaId: 'w1' } });
      expect(counts.templates).toBe(1);
    });

    it('purges the phone cache, which would otherwise outlive the rows', async () => {
      await service.deleteWaba(1, 'sso_org_1', 'w1');
      expect(mockRedis.invalidatePhoneCache).toHaveBeenCalledWith('p1');
    });

    it('tells Meta to stop sending webhooks while a token still exists', async () => {
      await service.deleteWaba(1, 'sso_org_1', 'w1');

      const [url] = (mockedAxios.delete as jest.Mock).mock.calls[0] as [string];
      expect(url).toContain('/w1/subscribed_apps');
    });

    it('still deletes when Meta refuses the unsubscribe', async () => {
      // A disconnected account has no usable token, and Meta's answer is not a
      // reason to keep our copy of the data.
      mockedAxios.delete = jest.fn().mockRejectedValue(new Error('expired'));

      await expect(service.deleteWaba(1, 'sso_org_1', 'w1')).resolves.toEqual(
        expect.objectContaining({ templates: 1 }),
      );
      expect(tx.waba.delete).toHaveBeenCalled();
    });

    it('skips Meta entirely when nobody is connected any more', async () => {
      const unsubscribe = jest.fn();
      mockedAxios.delete = unsubscribe;
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([]);

      await service.deleteWaba(1, 'sso_org_1', 'w1');

      expect(unsubscribe).not.toHaveBeenCalled();
      expect(tx.waba.delete).toHaveBeenCalled();
    });

    it('emails everyone who used the account, owner included', async () => {
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([
        { userId: 1 },
        { userId: 4 },
      ]);

      await service.deleteWaba(1, 'sso_org_1', 'w1');

      expect(mockMailNotifications.wabaDeleted).toHaveBeenCalledWith(
        [1, 4],
        'OneManPlay Games',
        'w1',
        expect.objectContaining({ templates: 1 }),
      );
    });
  });

  describe('subscribeAppToWaba', () => {
    it('POSTs to subscribed_apps and returns true on success', async () => {
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { success: true } });
      const result = await service.subscribeAppToWaba('w1', 'raw_token');
      expect(result).toBe(true);
      const [url] = (mockedAxios.post as jest.Mock).mock.calls[0];
      expect(url).toContain('/w1/subscribed_apps');
    });

    it('returns false (non-fatal) when Meta rejects the subscription', async () => {
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: { data: { error: { message: 'missing permission', code: 200 } } },
      });
      await expect(service.subscribeAppToWaba('w1', 'raw_token')).resolves.toBe(false);
    });
  });

  describe('subscribeExistingWaba', () => {
    it('throws NotFoundException when there is no connection', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue(null);
      await expect(service.subscribeExistingWaba(1, 'w1')).rejects.toThrow(NotFoundException);
    });

    it('decrypts the stored token and subscribes', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockEncryption.decrypt.mockReturnValue('raw_token');
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { success: true } });
      await expect(service.subscribeExistingWaba(1, 'w1')).resolves.toBe(true);
      expect(mockEncryption.decrypt).toHaveBeenCalledWith('enc');
    });
  });
});
