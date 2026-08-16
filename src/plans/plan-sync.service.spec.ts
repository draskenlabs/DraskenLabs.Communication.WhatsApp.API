import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PlanSyncService } from './plan-sync.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = { plan: { updateMany: jest.fn(), count: jest.fn() } };
const mockConfig = { get: jest.fn() };

describe('PlanSyncService', () => {
  let service: PlanSyncService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.plan.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.plan.count.mockResolvedValue(1);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanSyncService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get(PlanSyncService);
  });

  describe('parse', () => {
    it('reads a code:planId list, ignoring spacing', () => {
      const mapping = PlanSyncService.parse(
        ' starter:plan_a , growth:plan_b,business:plan_c ',
      );

      expect([...mapping]).toEqual([
        ['starter', 'plan_a'],
        ['growth', 'plan_b'],
        ['business', 'plan_c'],
      ]);
    });

    it('skips a malformed entry rather than failing the boot', () => {
      const mapping = PlanSyncService.parse('starter:plan_a,,broken,growth:');

      expect([...mapping]).toEqual([['starter', 'plan_a']]);
    });

    it('reads an unset variable as no mapping at all', () => {
      expect(PlanSyncService.parse(undefined).size).toBe(0);
    });
  });

  describe('sync', () => {
    it('points each tier at its Razorpay plan', async () => {
      mockConfig.get.mockReturnValue('starter:plan_a,growth:plan_b');

      const updated = await service.sync();

      expect(updated).toBe(2);
      expect(mockPrisma.plan.updateMany).toHaveBeenCalledWith({
        where: { code: 'starter', NOT: { razorpayPlanId: 'plan_a' } },
        data: { razorpayPlanId: 'plan_a' },
      });
    });

    it('does nothing at all when the mapping is unset', async () => {
      mockConfig.get.mockReturnValue(undefined);

      await service.sync();

      // A deployment selling one configured price has no mapping and must be
      // left exactly as it is.
      expect(mockPrisma.plan.updateMany).not.toHaveBeenCalled();
    });

    it('survives a code that is not a plan', async () => {
      mockConfig.get.mockReturnValue('enterprise:plan_x');
      mockPrisma.plan.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.plan.count.mockResolvedValue(0);

      await expect(service.sync()).resolves.toBe(0);
    });

    it('survives a duplicate id rather than failing the boot', async () => {
      mockConfig.get.mockReturnValue('starter:plan_a,growth:plan_a');
      mockPrisma.plan.updateMany
        .mockResolvedValueOnce({ count: 1 })
        // The unique index is what stops two tiers billing the same amount.
        .mockRejectedValueOnce(new Error('unique constraint'));

      await expect(service.sync()).resolves.toBe(1);
    });
  });
});
