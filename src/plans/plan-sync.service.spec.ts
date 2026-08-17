import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PlanSyncService } from './plan-sync.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = {
  plan: { updateMany: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  subscription: { count: jest.fn() },
  $executeRaw: jest.fn(),
};
const mockConfig = { get: jest.fn() };

describe('PlanSyncService', () => {
  let service: PlanSyncService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.plan.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.plan.count.mockResolvedValue(1);
    mockPrisma.plan.findMany.mockResolvedValue([
      { code: 'starter', razorpayPlanId: 'plan_a' },
    ]);
    mockPrisma.subscription.count.mockResolvedValue(0);
    mockPrisma.$executeRaw.mockResolvedValue(0);
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
  describe('adoptExisting', () => {
    it('gives subscriptions with no tier the one they are charged on', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(4);

      await expect(service.adoptExisting()).resolves.toBe(4);
      // A blank is filled and a tier already set is left alone, so running
      // this at every boot costs nothing and cannot overwrite a correction.
      const [statement] = mockPrisma.$executeRaw.mock.calls[0] as [unknown];
      const sql = String(statement);
      expect(sql).toContain('"planRefId" IS NULL');
      expect(sql).toContain('"razorpayPlanId"');
    });

    it('says how many live subscriptions no tier claims', async () => {
      mockPrisma.subscription.count.mockResolvedValue(2);
      const warn = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);

      await service.adoptExisting();

      // Those accounts are held to the entry limits until a tier is wired to
      // their plan id — worth saying out loud rather than leaving to be
      // discovered through a refused request.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('2 live subscription'),
      );
      warn.mockRestore();
    });

    it('never fails the boot', async () => {
      mockPrisma.$executeRaw.mockRejectedValue(new Error('db down'));

      await expect(service.adoptExisting()).resolves.toBe(0);
    });
  });
  describe('what it says at boot', () => {
    it('says so when the mapping is missing entirely', async () => {
      mockConfig.get.mockReturnValue(undefined);
      const warn = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);

      await service.sync();

      // Without this, an unconfigured deployment looks from the console like
      // a broken one: every tier offering "contact sales", an upgrade button
      // that will not enable, and nothing anywhere saying why.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('RAZORPAY_PLAN_IDS is not set'),
      );
      warn.mockRestore();
    });

    it('says so when the value is set but unreadable', async () => {
      mockConfig.get.mockReturnValue('starter=plan_a;growth=plan_b');
      const warn = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);

      await service.sync();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('no "code:plan_id" pair could be read'),
      );
      warn.mockRestore();
    });

    it('reports which tiers can be bought afterwards, not just what changed', async () => {
      mockConfig.get.mockReturnValue('starter:plan_a');
      mockPrisma.plan.findMany.mockResolvedValue([
        { code: 'starter', razorpayPlanId: 'plan_a' },
        { code: 'growth', razorpayPlanId: null },
      ]);
      const log = jest
        .spyOn(service['logger'], 'log')
        .mockImplementation(() => undefined);

      await service.sync();

      // A boot that changed nothing because everything was already right and
      // one that changed nothing because nothing matched read identically
      // otherwise.
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('1 of 2 sellable tier(s) are wired'),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('growth (none)'),
      );
      log.mockRestore();
    });
  });
});
