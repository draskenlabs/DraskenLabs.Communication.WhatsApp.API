import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectService } from './connect.service';
import { UserWhatsappService } from 'src/user/user-whatsapp.service';
import { WabaService } from 'src/waba/waba.service';
import { WabaProvisioningService } from 'src/provisioning/waba-provisioning.service';
import axios from 'axios';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockMailNotifications = mailNotificationsDouble();

describe('ConnectService', () => {
  let service: ConnectService;
  let configService: jest.Mocked<ConfigService>;
  let userWhatsappService: jest.Mocked<UserWhatsappService>;
  let wabaService: jest.Mocked<WabaService>;
  let provisioning: jest.Mocked<WabaProvisioningService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        ConnectService,
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test-value') } },
        { provide: UserWhatsappService, useValue: { createOrUpdate: jest.fn() } },
        {
          provide: WabaService,
          useValue: {
            createOrUpdateWaba: jest.fn(),
            subscribeAppToWaba: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: WabaProvisioningService, useValue: { syncedNumbers: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();

    service = module.get<ConnectService>(ConnectService);
    configService = module.get(ConfigService);
    userWhatsappService = module.get(UserWhatsappService);
    wabaService = module.get(WabaService);
    provisioning = module.get(WabaProvisioningService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw BadRequestException if token exchange fails', async () => {
    mockedAxios.get = jest.fn().mockResolvedValueOnce({ data: {} });

    await expect(
      service.connectWhatsapp({ code: 'bad', wabaId: 'w1', businessId: 'b1' }, 1, 'sso_org_1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('should connect and return phone numbers', async () => {
    mockedAxios.get = jest.fn()
      .mockResolvedValueOnce({ data: { access_token: 'tok' } })
      .mockResolvedValueOnce({ data: { id: 'w1', name: 'Test', currency: 'USD', timezone_id: '1', message_template_namespace: 'ns' } });

    wabaService.createOrUpdateWaba.mockResolvedValue({ wabaId: 'w1' } as any);
    userWhatsappService.createOrUpdate.mockResolvedValue({ accessToken: 'enc' } as any);
    // Already populated because another organisation pays for this account.
    provisioning.syncedNumbers.mockResolvedValue([
      { phoneNumberId: 'p1', displayPhoneNumber: '+1555', verifiedName: 'Test' },
    ]);

    const result = await service.connectWhatsapp({ code: 'code', wabaId: 'w1', businessId: 'b1' }, 1, 'sso_org_1');
    expect(result.wabaId).toBe('w1');
    expect(result.businessId).toBe('b1');
    expect(result.phoneNumbers).toHaveLength(1);
    expect(result.phoneNumbers[0].phoneNumberId).toBe('p1');
  });

  it('syncs nothing from Meta until the account is paid for', async () => {
    // Connecting records the account and stops. Phone numbers, templates and
    // the webhook subscription arrive when a subscription starts paying —
    // otherwise finishing signup would hand over the working product.
    mockedAxios.get = jest.fn()
      .mockResolvedValueOnce({ data: { access_token: 'tok' } })
      .mockResolvedValueOnce({ data: { id: 'w1', name: 'Test' } });

    wabaService.createOrUpdateWaba.mockResolvedValue({ wabaId: 'w1' } as any);
    userWhatsappService.createOrUpdate.mockResolvedValue({ accessToken: 'enc' } as any);
    provisioning.syncedNumbers.mockResolvedValue([]);

    const result = await service.connectWhatsapp(
      { code: 'code', wabaId: 'w1', businessId: 'b1' },
      1,
      'sso_org_1',
    );

    expect(wabaService.subscribeAppToWaba).not.toHaveBeenCalled();
    expect(result.phoneNumbers).toHaveLength(0);
  });

  it('derives businessId from the WABA when the client omits it', async () => {
    mockedAxios.get = jest.fn()
      .mockResolvedValueOnce({ data: { access_token: 'tok' } })
      .mockResolvedValueOnce({ data: { id: 'w1', name: 'Test', owner_business_info: { id: 'biz_from_meta' } } });

    wabaService.createOrUpdateWaba.mockResolvedValue({ wabaId: 'w1' } as any);
    userWhatsappService.createOrUpdate.mockResolvedValue({ accessToken: 'enc' } as any);
    provisioning.syncedNumbers.mockResolvedValue([]);

    const result = await service.connectWhatsapp({ code: 'code', wabaId: 'w1' }, 1, 'sso_org_1');
    expect(result.businessId).toBe('biz_from_meta');
    expect(userWhatsappService.createOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz_from_meta' }),
    );
  });

  it('throws when no businessId can be determined', async () => {
    mockedAxios.get = jest.fn()
      .mockResolvedValueOnce({ data: { access_token: 'tok' } })
      .mockResolvedValueOnce({ data: { id: 'w1', name: 'Test' } });

    await expect(
      service.connectWhatsapp({ code: 'code', wabaId: 'w1' }, 1, 'sso_org_1'),
    ).rejects.toThrow(BadRequestException);
  });

  describe('manualConnect', () => {
    it('is disabled unless ALLOW_MANUAL_CONNECT is true', async () => {
      configService.get.mockReturnValue(false);
      await expect(
        service.manualConnect({ wabaId: 'w1', accessToken: 't' }, 1, 'sso_org_1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('connects with a supplied token, without an OAuth exchange or a sync', async () => {
      configService.get.mockImplementation((k: string) =>
        k === 'ALLOW_MANUAL_CONNECT' ? 'true' : 'x',
      );
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: { id: 'w1', name: 'Test WABA', owner_business_info: { id: 'b9' } },
      });
      userWhatsappService.createOrUpdate.mockResolvedValue({ accessToken: 'enc' } as any);
      provisioning.syncedNumbers.mockResolvedValue([
        { phoneNumberId: 'p1', displayPhoneNumber: '+1 555', verifiedName: 'Test' },
      ]);

      const result = await service.manualConnect(
        { wabaId: 'w1', accessToken: 'raw' },
        1,
        'sso_org_1',
      );

      expect(mockedAxios.post).not.toHaveBeenCalled(); // no code→token exchange
      expect(wabaService.createOrUpdateWaba).toHaveBeenCalled();
      expect(userWhatsappService.createOrUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ wabaId: 'w1', accessToken: 'raw', businessId: 'b9' }),
      );
      expect(wabaService.subscribeAppToWaba).not.toHaveBeenCalled();
      expect(result.phoneNumbers).toHaveLength(1);
    });
  });
});
