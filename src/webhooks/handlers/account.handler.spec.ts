import { Test, TestingModule } from '@nestjs/testing';
import { AccountHandler } from './account.handler';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

const mockPrisma = {
  wabaPhoneNumber: { updateMany: jest.fn(), findFirst: jest.fn() },
  phoneQualityEvent: { create: jest.fn() },
};

const mockMailNotifications = mailNotificationsDouble();

describe('AccountHandler', () => {
  let handler: AccountHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    // No name in use unless a test says otherwise — a fresh number.
    mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({
      nameStatus: null,
      phoneNumberId: 'pn1',
      wabaId: 'waba1',
    });
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
        rejectionReason: undefined,
      });
    });

    it("passes on Meta's reason for a refusal", async () => {
      // The decision alone does not say what to change about the name.
      await handler.handlePhoneNameUpdate(
        {
          display_phone_number: '+15550051310',
          decision: 'REJECTED',
          requested_verified_name: 'Best Bank Ever',
          rejection_reason: 'TRADEMARK_VIOLATION',
        },
        'waba1',
      );

      expect(mockMailNotifications.displayNameDecision).toHaveBeenCalledWith(
        expect.objectContaining({ rejectionReason: 'TRADEMARK_VIOLATION' }),
      );
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
        data: {
          nameStatus: 'APPROVED',
          verifiedName: 'Drasken Labs',
          // The request is settled, so nothing is left showing as pending.
          newDisplayName: null,
          newNameStatus: null,
        },
      });
    });

    it("records a first name's rejection against the number itself", async () => {
      // Nothing is in use yet, so the refused name is the only one there is.
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
        data: {
          nameStatus: 'DECLINED',
          newDisplayName: null,
          newNameStatus: null,
        },
      });
    });

    it('leaves a live name alone when a rename is refused', async () => {
      // The refusal is about the requested name. Writing it to `nameStatus`
      // told the customer the name recipients are seeing had been declined.
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({
        nameStatus: 'APPROVED',
      });
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
        data: { newNameStatus: 'DECLINED', newDisplayName: 'Something Else' },
      });
    });

    it('protects a name cleared without review just the same', async () => {
      // AVAILABLE_WITHOUT_REVIEW is in use exactly like an approved name — it
      // is the usual outcome for a name matching the verified business.
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({
        nameStatus: 'AVAILABLE_WITHOUT_REVIEW',
      });
      mockPrisma.wabaPhoneNumber.updateMany.mockResolvedValue({ count: 1 });

      await handler.handlePhoneNameUpdate(
        {
          display_phone_number: '+15550051310',
          decision: 'REJECTED',
          requested_verified_name: 'Something Else',
        },
        'waba1',
      );

      expect(mockPrisma.wabaPhoneNumber.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { newNameStatus: 'DECLINED', newDisplayName: 'Something Else' },
        }),
      );
    });

    it('reads a deferred review as still in review', async () => {
      // Meta holding the request for a longer look is not a verdict. It used
      // to fall through unrecognised and leave the console on the old answer.
      mockPrisma.wabaPhoneNumber.updateMany.mockResolvedValue({ count: 1 });

      await handler.handlePhoneNameUpdate(
        {
          display_phone_number: '+15550051310',
          decision: 'DEFERRED',
          requested_verified_name: 'Drasken Labs',
        },
        'waba1',
      );

      expect(mockPrisma.wabaPhoneNumber.updateMany).toHaveBeenCalledWith({
        where: { displayPhoneNumber: '+15550051310', wabaId: 'waba1' },
        data: {
          nameStatus: 'PENDING_REVIEW',
          newDisplayName: null,
          newNameStatus: null,
        },
      });
    });

    it('shows a rename in review beside the name still in use', async () => {
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({
        nameStatus: 'APPROVED',
      });
      mockPrisma.wabaPhoneNumber.updateMany.mockResolvedValue({ count: 1 });

      await handler.handlePhoneNameUpdate(
        {
          display_phone_number: '+15550051310',
          decision: 'DEFERRED',
          requested_verified_name: 'Drasken Labs Support',
        },
        'waba1',
      );

      expect(mockPrisma.wabaPhoneNumber.updateMany).toHaveBeenCalledWith({
        where: { displayPhoneNumber: '+15550051310', wabaId: 'waba1' },
        data: {
          newNameStatus: 'PENDING_REVIEW',
          newDisplayName: 'Drasken Labs Support',
        },
      });
    });

    it('clears the pending rename once it is approved', async () => {
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({
        nameStatus: 'APPROVED',
      });
      mockPrisma.wabaPhoneNumber.updateMany.mockResolvedValue({ count: 1 });

      await handler.handlePhoneNameUpdate(
        {
          display_phone_number: '+15550051310',
          decision: 'APPROVED',
          requested_verified_name: 'Drasken Labs Support',
        },
        'waba1',
      );

      expect(mockPrisma.wabaPhoneNumber.updateMany).toHaveBeenCalledWith({
        where: { displayPhoneNumber: '+15550051310', wabaId: 'waba1' },
        data: {
          nameStatus: 'APPROVED',
          verifiedName: 'Drasken Labs Support',
          newDisplayName: null,
          newNameStatus: null,
        },
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
      mockPrisma.wabaPhoneNumber.findFirst.mockRejectedValue(
        new Error('db down'),
      );
      mockPrisma.wabaPhoneNumber.updateMany.mockRejectedValue(
        new Error('db down'),
      );

      await expect(
        handler.handlePhoneNameUpdate(
          { display_phone_number: '+15550051310', decision: 'APPROVED' },
          'waba1',
        ),
      ).resolves.toBeUndefined();
    });
  });
});
