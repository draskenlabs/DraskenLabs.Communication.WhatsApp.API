import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { RazorpaySignatureMiddleware } from './razorpay-signature.middleware';
import { RazorpayService } from '../razorpay.service';

const SECRET = 'whsec_test';
const mockRazorpay = { webhookSecret: SECRET };

const sign = (body: string) =>
  createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');

describe('RazorpaySignatureMiddleware', () => {
  let middleware: RazorpaySignatureMiddleware;
  let next: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    next = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RazorpaySignatureMiddleware,
        { provide: RazorpayService, useValue: mockRazorpay },
      ],
    }).compile();
    middleware = module.get<RazorpaySignatureMiddleware>(
      RazorpaySignatureMiddleware,
    );
  });

  const request = (body: string, signature?: string) =>
    ({
      headers: signature ? { 'x-razorpay-signature': signature } : {},
      rawBody: Buffer.from(body),
    }) as any;

  it('accepts a correctly signed body', () => {
    const body = '{"event":"subscription.charged"}';

    middleware.use(request(body, sign(body)), {} as any, next);

    expect(next).toHaveBeenCalled();
  });

  it('rejects a body that was altered in flight', () => {
    const body = '{"event":"subscription.charged"}';
    const tampered = '{"event":"subscription.cancelled"}';

    expect(() =>
      middleware.use(request(tampered, sign(body)), {} as any, next),
    ).toThrow(UnauthorizedException);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature', () => {
    expect(() => middleware.use(request('{}'), {} as any, next)).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a signature of the wrong length rather than comparing it', () => {
    // timingSafeEqual throws on a length mismatch; the guard has to come first.
    expect(() =>
      middleware.use(request('{}', 'abcd'), {} as any, next),
    ).toThrow(UnauthorizedException);
  });
});
