import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { WabaProvisioningService } from './waba-provisioning.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { WabaService } from 'src/waba/waba.service';
import { WabaMembershipService } from 'src/waba/waba-membership.service';
import { WabaPhoneNumberService } from 'src/waba-phone-number/waba-phone-number.service';
import { TemplatesService } from 'src/templates/templates.service';

const mockPrisma = { wabaPhoneNumber: { count: jest.fn(), findMany: jest.fn() } };
const mockEncryption = { decrypt: jest.fn().mockReturnValue('raw_token') };
const mockWaba = { subscribeAppToWaba: jest.fn().mockResolvedValue(true) };
const mockMembership = {
  require: jest.fn().mockResolvedValue({ wabaId: 'w1', name: 'Games' }),
  connection: jest.fn().mockResolvedValue({ userId: 3, accessToken: 'enc' }),
};
const mockPhones = { syncPhoneNumbersWithToken: jest.fn().mockResolvedValue([]) };
const mockTemplates = {
  syncTemplates: jest.fn().mockResolvedValue({ synced: 0, wabaId: 'w1' }),
};

describe('WabaProvisioningService', () => {
  let service: WabaProvisioningService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockWaba.subscribeAppToWaba.mockResolvedValue(true);
    mockMembership.connection.mockResolvedValue({ userId: 3, accessToken: 'enc' });
    mockPhones.syncPhoneNumbersWithToken.mockResolvedValue([]);
    mockTemplates.syncTemplates.mockResolvedValue({ synced: 0, wabaId: 'w1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WabaProvisioningService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: WabaService, useValue: mockWaba },
        { provide: WabaMembershipService, useValue: mockMembership },
        { provide: WabaPhoneNumberService, useValue: mockPhones },
        { provide: TemplatesService, useValue: mockTemplates },
      ],
    }).compile();
    service = module.get(WabaProvisioningService);
  });

  it('pulls everything the account needs to be usable', async () => {
    mockPhones.syncPhoneNumbersWithToken.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    mockTemplates.syncTemplates.mockResolvedValue({ synced: 5, wabaId: 'w1' });

    const result = await service.provision('org_1', 'w1');

    expect(mockWaba.subscribeAppToWaba).toHaveBeenCalledWith('w1', 'raw_token');
    expect(mockPhones.syncPhoneNumbersWithToken).toHaveBeenCalledWith('w1', 'raw_token', 'enc');
    expect(mockTemplates.syncTemplates).toHaveBeenCalledWith(3, 'org_1', 'w1');
    expect(result).toEqual({
      phoneNumbers: 2,
      templates: 5,
      subscribed: true,
      failures: [],
    });
  });

  it('carries on when one step fails', async () => {
    // A Meta outage must not leave a paid subscription looking unpaid, and the
    // steps are independent — templates failing is no reason to skip numbers.
    mockPhones.syncPhoneNumbersWithToken.mockRejectedValue(new Error('Meta is down'));
    mockTemplates.syncTemplates.mockResolvedValue({ synced: 3, wabaId: 'w1' });

    const result = await service.provision('org_1', 'w1');

    expect(result.failures).toEqual(['phoneNumbers']);
    expect(result.templates).toBe(3);
  });

  it('gives up quietly when the account has no connection left', async () => {
    mockMembership.connection.mockRejectedValue(new NotFoundException('gone'));

    const result = await service.provision('org_1', 'w1');

    expect(result.failures).toEqual(['connection']);
    expect(mockPhones.syncPhoneNumbersWithToken).not.toHaveBeenCalled();
  });

  it('uses the organisation`s own connection, not the account`s first', async () => {
    await service.provision('org_2', 'w1');
    expect(mockMembership.connection).toHaveBeenCalledWith('org_2', 'w1');
  });

  describe('isProvisioned', () => {
    it('is false before anything has been pulled', async () => {
      mockPrisma.wabaPhoneNumber.count.mockResolvedValue(0);
      await expect(service.isProvisioned('w1')).resolves.toBe(false);
    });

    it('is true once numbers are on record', async () => {
      mockPrisma.wabaPhoneNumber.count.mockResolvedValue(2);
      await expect(service.isProvisioned('w1')).resolves.toBe(true);
    });
  });

  describe('syncedNumbers', () => {
    it('is empty for a connected account nobody has paid for', async () => {
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([]);
      await expect(service.syncedNumbers('org_1', 'w1')).resolves.toEqual([]);
    });

    it('returns what another organisation already paid to pull', async () => {
      // Numbers belong to the account; the subscription belongs to the
      // organisation. Connecting an account someone else already pays for
      // should not look empty.
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([
        { phoneNumberId: 'p1', displayPhoneNumber: '+1555', verifiedName: 'Games' },
      ]);

      await expect(service.syncedNumbers('org_2', 'w1')).resolves.toHaveLength(1);
      expect(mockMembership.require).toHaveBeenCalledWith('org_2', 'w1');
    });
  });
});
