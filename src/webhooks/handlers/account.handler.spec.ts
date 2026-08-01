import { Test, TestingModule } from '@nestjs/testing';
import { AccountHandler } from './account.handler';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

const mockPrisma = {
  wabaPhoneNumber: { updateMany: jest.fn() },
};

const mockMailNotifications = mailNotificationsDouble();

describe('AccountHandler', () => {
  let handler: AccountHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        AccountHandler,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    handler = module.get<AccountHandler>(AccountHandler);
  });

  describe('handleAccountUpdate', () => {
    it('logs the event without throwing', () => {
      expect(() =>
        handler.handleAccountUpdate({
          phone_number: '+1555',
          event: 'ACCOUNT_UPDATE',
        }),
      ).not.toThrow();
    });

    it('emails everyone on the WABA when Meta bans it', () => {
      handler.handleAccountUpdate(
        {
          event: 'ACCOUNT_VIOLATION',
          ban_info: { waba_ban_state: 'SCHEDULE_FOR_DISABLE' },
        },
        'waba1',
      );

      expect(mockMailNotifications.wabaBanned).toHaveBeenCalledWith(
        'waba1',
        'SCHEDULE_FOR_DISABLE',
      );
    });

    it('stays quiet for an ordinary account update', () => {
      handler.handleAccountUpdate({ event: 'PARTNER_ADDED' }, 'waba1');
      expect(mockMailNotifications.wabaBanned).not.toHaveBeenCalled();
    });
  });

  describe('handlePhoneQualityUpdate', () => {
    it('updates quality rating for matching phone number', async () => {
      mockPrisma.wabaPhoneNumber.updateMany.mockResolvedValue({ count: 1 });
      await handler.handlePhoneQualityUpdate({
        display_phone_number: '+1555',
        event: 'FLAGGED',
        current_limit: 'TIER_50',
      });
      expect(mockPrisma.wabaPhoneNumber.updateMany).toHaveBeenCalledWith({
        where: { displayPhoneNumber: '+1555' },
        data: { qualityRating: 'TIER_50' },
      });
    });

    it('uses event as fallback when current_limit is absent', async () => {
      mockPrisma.wabaPhoneNumber.updateMany.mockResolvedValue({ count: 1 });
      await handler.handlePhoneQualityUpdate({
        display_phone_number: '+1555',
        event: 'FLAGGED',
        current_limit: null,
      });
      expect(mockPrisma.wabaPhoneNumber.updateMany).toHaveBeenCalledWith({
        where: { displayPhoneNumber: '+1555' },
        data: { qualityRating: 'FLAGGED' },
      });
    });

    it('handles DB error gracefully without throwing', async () => {
      mockPrisma.wabaPhoneNumber.updateMany.mockRejectedValue(new Error('DB error'));
      await expect(
        handler.handlePhoneQualityUpdate({ display_phone_number: '+1555', event: 'FLAGGED', current_limit: null }),
      ).resolves.toBeUndefined();
    });
  });

  describe('handlePhoneNameUpdate', () => {
    it('logs without throwing', () => {
      expect(() =>
        handler.handlePhoneNameUpdate({ phone_number: '+1555' }),
      ).not.toThrow();
    });

    it('emails the display-name decision when the WABA is known', () => {
      handler.handlePhoneNameUpdate(
        {
          display_phone_number: '+15550051310',
          decision: 'APPROVED',
          requested_verified_name: 'Drasken Labs',
        },
        'waba1',
      );

      expect(mockMailNotifications.displayNameDecision).toHaveBeenCalledWith({
        wabaId: 'waba1',
        displayPhoneNumber: '+15550051310',
        decision: 'APPROVED',
        requestedName: 'Drasken Labs',
      });
    });
  });
});
