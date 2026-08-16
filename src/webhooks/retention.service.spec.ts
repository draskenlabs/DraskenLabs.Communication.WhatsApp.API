import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RetentionService } from './retention.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';

const mockPrisma = {
  $executeRaw: jest.fn(),
  wabaOrganisation: { findMany: jest.fn() },
  message: { count: jest.fn(), deleteMany: jest.fn() },
  inboundMessage: { count: jest.fn(), deleteMany: jest.fn() },
};
const mockLimits = { forOrg: jest.fn() };

const config = (values: Record<string, string> = {}) => ({
  get: (key: string) => values[key],
});

const limits = (historyDays: number | null) => ({
  planCode: 'starter',
  planName: 'Starter',
  wabas: 1,
  phoneNumbersPerWaba: 1,
  teamMembers: 2,
  webhookEndpoints: 2,
  historyDays,
});

async function build(values: Record<string, string> = {}): Promise<RetentionService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RetentionService,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: ConfigService, useValue: config(values) },
      { provide: PlanLimitsService, useValue: mockLimits },
    ],
  }).compile();
  return module.get(RetentionService);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$executeRaw.mockResolvedValue(0);
  mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);
  mockPrisma.message.count.mockResolvedValue(0);
  mockPrisma.inboundMessage.count.mockResolvedValue(0);
  mockPrisma.message.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.inboundMessage.deleteMany.mockResolvedValue({ count: 0 });
});

describe('RetentionService', () => {
  it('deletes the delivery log before the events it points at', async () => {
    const service = await build();
    mockPrisma.$executeRaw.mockResolvedValue(3);

    await service.sweep();

    const [first, second] = mockPrisma.$executeRaw.mock.calls.map(([sql]) =>
      JSON.stringify(sql),
    );
    // The other order leaves the delivery rows behind with a null event.
    expect(first).toContain('WebhookDelivery');
    expect(second).toContain('WebhookEvent');
  });

  it('leaves a delivery still queued or retrying alone', async () => {
    const service = await build();

    await service.sweep();

    const [[sql]] = mockPrisma.$executeRaw.mock.calls;
    const text = JSON.stringify(sql);
    expect(text).toContain('sent');
    expect(text).toContain('abandoned');
    expect(text).not.toContain('pending');
  });

  it('keeps deleting until a batch comes back short', async () => {
    const service = await build();
    mockPrisma.$executeRaw
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(1200)
      .mockResolvedValue(0);

    const { deliveries } = await service.sweep();

    expect(deliveries).toBe(6200);
  });

  describe('message history', () => {
    beforeEach(() => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([{ ssoOrgId: 'org_1' }]);
      mockLimits.forOrg.mockResolvedValue(limits(30));
    });

    it('only counts, and says so, until a deployment turns it on', async () => {
      const service = await build();
      mockPrisma.message.count.mockResolvedValue(12);

      const { messages } = await service.sweep();

      // Somebody's own record of what they sent: not deleted on a default.
      expect(mockPrisma.message.deleteMany).not.toHaveBeenCalled();
      expect(messages).toBe(0);
    });

    it('applies the window once it is turned on', async () => {
      const service = await build({ PLAN_RETENTION_ENFORCED: 'true' });
      mockPrisma.message.deleteMany.mockResolvedValue({ count: 12 });
      mockPrisma.inboundMessage.deleteMany.mockResolvedValue({ count: 4 });

      const { messages, inbound } = await service.sweep();

      expect(messages).toBe(12);
      expect(inbound).toBe(4);
      const { where } = mockPrisma.message.deleteMany.mock.calls[0][0];
      expect(where.ssoOrgId).toBe('org_1');
      expect(where.createdAt.lt).toBeInstanceOf(Date);
    });

    it('keeps everything for a plan that names no window', async () => {
      const service = await build({ PLAN_RETENTION_ENFORCED: 'true' });
      // Agency's retention is negotiated; a missing number is not "delete all".
      mockLimits.forOrg.mockResolvedValue(limits(null));

      await service.sweep();

      expect(mockPrisma.message.deleteMany).not.toHaveBeenCalled();
    });

    it('holds each organisation to its own plan, not one global window', async () => {
      const service = await build({ PLAN_RETENTION_ENFORCED: 'true' });
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { ssoOrgId: 'org_1' },
        { ssoOrgId: 'org_2' },
      ]);
      mockLimits.forOrg
        .mockResolvedValueOnce(limits(30))
        .mockResolvedValueOnce(limits(365));

      await service.sweep();

      const [first, second] = mockPrisma.message.deleteMany.mock.calls.map(
        ([args]) => args.where.createdAt.lt as Date,
      );
      // The Business customer keeps a year where the Starter one keeps a month.
      expect(first.getTime()).toBeGreaterThan(second.getTime());
    });
  });
});
