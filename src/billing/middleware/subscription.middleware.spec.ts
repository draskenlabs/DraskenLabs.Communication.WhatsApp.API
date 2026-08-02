import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { SubscriptionMiddleware } from './subscription.middleware';
import { SubscriptionAccessService } from '../subscription-access.service';
import { RazorpayService } from '../razorpay.service';

const mockBilling = { hasAccess: jest.fn() };
const mockRazorpay = { isConfigured: jest.fn() };

describe('SubscriptionMiddleware', () => {
  let middleware: SubscriptionMiddleware;
  let next: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    next = jest.fn();
    mockRazorpay.isConfigured.mockReturnValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionMiddleware,
        { provide: SubscriptionAccessService, useValue: mockBilling },
        { provide: RazorpayService, useValue: mockRazorpay },
      ],
    }).compile();
    middleware = module.get<SubscriptionMiddleware>(SubscriptionMiddleware);
  });

  it('lets a key through when its own account is subscribed', async () => {
    mockBilling.hasAccess.mockResolvedValue(true);

    await middleware.use(
      { authType: 'apiKey', orgId: 'org_1', apiKeyWabaId: 'waba_1' } as any,
      {} as any,
      next,
    );

    // The account charged is the one the key names, in the organisation the
    // key was issued in — a key from another org is another subscription.
    expect(mockBilling.hasAccess).toHaveBeenCalledWith('org_1', 'waba_1');
    expect(next).toHaveBeenCalled();
  });

  it('refuses a key whose account is paid for in a different organisation', async () => {
    mockBilling.hasAccess.mockImplementation((ssoOrgId: string) =>
      Promise.resolve(ssoOrgId === 'org_1'),
    );

    const req = {
      authType: 'apiKey',
      orgId: 'org_2',
      apiKeyWabaId: 'waba_1',
    } as any;
    await expect(middleware.use(req, {} as any, next)).rejects.toMatchObject({
      status: 402,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 402 when the key’s account is not subscribed', async () => {
    mockBilling.hasAccess.mockResolvedValue(false);

    const req = { authType: 'apiKey', orgId: 'org_1', apiKeyWabaId: 'waba_2' } as any;
    await expect(middleware.use(req, {} as any, next)).rejects.toMatchObject({
      status: 402,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves the console alone', async () => {
    // The JWT path is free: someone who stopped paying can still read their
    // history, export it and subscribe again.
    await middleware.use(
      { authType: 'jwt', orgId: 'org_1' } as any,
      {} as any,
      next,
    );

    expect(mockBilling.hasAccess).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('charges nobody when the deployment has no payment provider', async () => {
    mockRazorpay.isConfigured.mockReturnValue(false);

    await middleware.use(
      { authType: 'apiKey', orgId: 'org_1', apiKeyWabaId: 'waba_1' } as any,
      {} as any,
      next,
    );

    expect(mockBilling.hasAccess).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('refuses a key naming no account rather than failing open', async () => {
    await expect(
      middleware.use({ authType: 'apiKey', orgId: 'org_1' } as any, {} as any, next),
    ).rejects.toThrow(HttpException);
  });
});
