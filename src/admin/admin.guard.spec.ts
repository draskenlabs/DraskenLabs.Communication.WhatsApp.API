import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { SsoTokenService } from 'src/auth/sso-token.service';
import { AdminGuard, actorOf } from './admin.guard';
import { PrismaService } from 'src/prisma/prisma.service';
import type { Request } from 'express';

const mockSsoToken = { verify: jest.fn() };
const mockPrisma = { user: { findUnique: jest.fn() } };

const contextFor = (
  headers: Record<string, string> = {},
): { context: ExecutionContext; req: Request } => {
  const req = { headers } as unknown as Request;
  return {
    req,
    context: {
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext,
  };
};

describe('AdminGuard', () => {
  let guard: AdminGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AdminGuard(
      mockSsoToken as unknown as SsoTokenService,
      mockPrisma as unknown as PrismaService,
    );
    mockSsoToken.verify.mockResolvedValue({ sub: 'user_2abc', sid: 'sess_1' });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 7,
      email: 'ops@drasken.com',
      firstName: 'Ops',
      lastName: 'Person',
      isAdmin: true,
    });
  });

  it('lets an admin through and says who they are', async () => {
    const { context, req } = contextFor({ authorization: 'Bearer good' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(actorOf(req)).toEqual({
      id: 7,
      email: 'ops@drasken.com',
      name: 'Ops Person',
    });
  });

  // Every refusal is the same answer. A 401 would confirm to anybody probing
  // that /admin is a real route; a 403 would confirm it to any customer
  // holding a valid token.

  it('answers not-found when there is no token', async () => {
    const { context } = contextFor();

    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
  });

  it('answers not-found when the token does not verify', async () => {
    mockSsoToken.verify.mockRejectedValue(new Error('expired'));
    const { context } = contextFor({ authorization: 'Bearer stale' });

    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
  });

  it('answers not-found for a valid token belonging to nobody', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const { context } = contextFor({ authorization: 'Bearer good' });

    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
  });

  it('answers not-found for a signed-in customer who is not an admin', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 7,
      email: 'customer@example.com',
      firstName: null,
      lastName: null,
      isAdmin: false,
    });
    const { context } = contextFor({ authorization: 'Bearer good' });

    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
  });

  it('refuses a token that is not a bearer token', async () => {
    const { context } = contextFor({ authorization: 'Basic abc' });

    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
    expect(mockSsoToken.verify).not.toHaveBeenCalled();
  });

  it('reads the flag from the database rather than any session cache', async () => {
    // A cached admin flag would let a demoted operator keep the console until
    // the cache expired. Admin requests are rare; this is one indexed read.
    const { context } = contextFor({ authorization: 'Bearer good' });

    await guard.canActivate(context);

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ssoId: 'user_2abc' } }),
    );
  });

  it('names an operator with no name at all as null, not as a blank', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 7,
      email: 'ops@drasken.com',
      firstName: null,
      lastName: null,
      isAdmin: true,
    });
    const { context, req } = contextFor({ authorization: 'Bearer good' });

    await guard.canActivate(context);

    expect(actorOf(req).name).toBeNull();
  });
});
