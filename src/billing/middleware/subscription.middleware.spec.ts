import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { SubscriptionMiddleware } from './subscription.middleware';
import { BillingService } from '../billing.service';
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
        { provide: BillingService, useValue: mockBilling },
        { provide: RazorpayService, useValue: mockRazorpay },
      ],
    }).compile();
    middleware = module.get<SubscriptionMiddleware>(SubscriptionMiddleware);
  });

  it('lets a subscribed API key through', async () => {
    mockBilling.hasAccess.mockResolvedValue(true);

    await middleware.use({ authType: 'apiKey', orgId: 'org_1' } as any, {} as any, next);

    expect(next).toHaveBeenCalled();
  });

  it('answers 402 for an API key with no subscription', async () => {
    mockBilling.hasAccess.mockResolvedValue(false);

    const req = { authType: 'apiKey', orgId: 'org_1' } as any;
    await expect(middleware.use(req, {} as any, next)).rejects.toMatchObject({
      status: 402,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves the console alone', async () => {
    // The JWT path is free: someone who stopped paying can still read their
    // history, export it and subscribe again.
    await middleware.use({ authType: 'jwt', orgId: 'org_1' } as any, {} as any, next);

    expect(mockBilling.hasAccess).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('charges nobody when the deployment has no payment provider', async () => {
    mockRazorpay.isConfigured.mockReturnValue(false);

    await middleware.use({ authType: 'apiKey', orgId: 'org_1' } as any, {} as any, next);

    expect(mockBilling.hasAccess).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('refuses an API key with no organisation rather than failing open', async () => {
    await expect(
      middleware.use({ authType: 'apiKey' } as any, {} as any, next),
    ).rejects.toThrow(HttpException);
  });
});
