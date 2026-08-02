import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { WabaPhoneNumberController } from './waba-phone-number.controller';
import { WabaPhoneNumberService } from './waba-phone-number.service';

const mockPhoneNumberService = {
  findAllByWabaId: jest.fn(),
  syncPhoneNumbers: jest.fn(),
};

describe('WabaPhoneNumberController', () => {
  let controller: WabaPhoneNumberController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WabaPhoneNumberController],
      providers: [{ provide: WabaPhoneNumberService, useValue: mockPhoneNumberService }],
    }).compile();
    controller = module.get<WabaPhoneNumberController>(WabaPhoneNumberController);
  });

  describe('findAll', () => {
    it('returns phone numbers for a WABA', async () => {
      const req = { user: { id: 1 }, orgId: 'sso_org_1' } as any;
      const phones = [{ phoneNumberId: 'p1' }];
      mockPhoneNumberService.findAllByWabaId.mockResolvedValue(phones);

      // Listed for the organisation, not for whoever connected the account —
      // the id passed down is the org's.
      await expect(controller.findAll('w1', req)).resolves.toEqual(phones);
      expect(mockPhoneNumberService.findAllByWabaId).toHaveBeenCalledWith('sso_org_1', 'w1');
    });

    it('throws UnauthorizedException when the organisation is missing', async () => {
      await expect(controller.findAll('w1', { user: { id: 1 } } as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('sync', () => {
    it('syncs phone numbers from Meta', async () => {
      const req = { user: { id: 1 }, orgId: 'sso_org_1' } as any;
      const phones = [{ phoneNumberId: 'p1' }];
      mockPhoneNumberService.syncPhoneNumbers.mockResolvedValue(phones);

      await expect(controller.sync('w1', req)).resolves.toEqual(phones);
      expect(mockPhoneNumberService.syncPhoneNumbers).toHaveBeenCalledWith(
        1,
        'sso_org_1',
        'w1',
      );
    });

    it('throws UnauthorizedException when user missing', async () => {
      await expect(controller.sync('w1', {} as any)).rejects.toThrow(UnauthorizedException);
    });
  });
});
