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
    it('logs without throwing', async () => {
      await expect(
        handler.handlePhoneNameUpdate({ phone_number: '+1555' }),
      ).resolves.toBeUndefined();
    });

    it('emails the display-name decision when the WABA is known', async () => {
      mockPrisma.wabaPhoneNumber.updateMany.mockResolvedValue({ count: 1 });

      await handler.handlePhoneNameUpdate(
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

    it('records an approval, and the name it approved', async () => {
      // The console reads `nameStatus` off the row. A decision that only
      // reached an inbox left the number claiming its previous status until
      // somebody happened to run a sync.
      mockPrisma.wabaPhoneNumber.updateMany.mockResolvedValue({ count: 1 });

      await handler.handlePhoneNameUpdate(
        {
          display_phone_number: '+15550051310',
          decision: 'APPROVED',
          requested_verified_name: 'Drasken Labs',
        },
        'waba1',
      );

      expect(mockPrisma.wabaPhoneNumber.updateMany).toHaveBeenCalledWith({
        where: { displayPhoneNumber: '+15550051310', wabaId: 'waba1' },
        data: { nameStatus: 'APPROVED', verifiedName: 'Drasken Labs' },
      });
    });

    it('records a rejection without touching the name in use', async () => {
      mockPrisma.wabaPhoneNumber.updateMany.mockResolvedValue({ count: 1 });

      await handler.handlePhoneNameUpdate(
        {
          display_phone_number: '+15550051310',
          decision: 'REJECTED',
          requested_verified_name: 'Something Else',
        },
        'waba1',
      );

      expect(mockPrisma.wabaPhoneNumber.updateMany).toHaveBeenCalledWith({
        where: { displayPhoneNumber: '+15550051310', wabaId: 'waba1' },
        data: { nameStatus: 'DECLINED' },
      });
    });

    it('writes nothing for a decision it does not recognise', async () => {
      // Better no answer than a wrong one written over what a sync knows.
      await handler.handlePhoneNameUpdate(
        { display_phone_number: '+15550051310', decision: 'SOMETHING_NEW' },
        'waba1',
      );

      expect(mockPrisma.wabaPhoneNumber.updateMany).not.toHaveBeenCalled();
    });

    it('survives a database failure', async () => {
      mockPrisma.wabaPhoneNumber.updateMany.mockRejectedValue(new Error('db down'));

      await expect(
        handler.handlePhoneNameUpdate(
          { display_phone_number: '+15550051310', decision: 'APPROVED' },
          'waba1',
        ),
      ).resolves.toBeUndefined();
    });
  });
});
