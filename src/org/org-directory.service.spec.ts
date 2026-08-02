import { Test, TestingModule } from '@nestjs/testing';
import { OrgDirectoryService } from './org-directory.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

const mockPrisma = {
  wabaOrganisation: { findFirst: jest.fn(), findMany: jest.fn() },
};
const mockRedis = { getOrgName: jest.fn(), setOrgName: jest.fn() };

describe('OrgDirectoryService', () => {
  let service: OrgDirectoryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrgDirectoryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get(OrgDirectoryService);
  });

  describe('name', () => {
    it('answers from the cache', async () => {
      mockRedis.getOrgName.mockResolvedValue('Another Organisation');

      await expect(service.name('org_2')).resolves.toBe('Another Organisation');
      expect(mockPrisma.wabaOrganisation.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to the copy written at connect, and re-caches it', async () => {
      // Redis expires; the column is what makes a name survive a restart with
      // nobody logged in — which is exactly when a billing cron sends mail.
      mockRedis.getOrgName.mockResolvedValue(null);
      mockPrisma.wabaOrganisation.findFirst.mockResolvedValue({
        orgName: 'Drasken Labs',
      });

      await expect(service.name('org_1')).resolves.toBe('Drasken Labs');
      expect(mockRedis.setOrgName).toHaveBeenCalledWith('org_1', 'Drasken Labs');
    });

    it('is null when nothing has ever told us', async () => {
      mockRedis.getOrgName.mockResolvedValue(null);
      mockPrisma.wabaOrganisation.findFirst.mockResolvedValue(null);

      await expect(service.name('org_9')).resolves.toBeNull();
    });

    it('is null rather than throwing when the lookup fails', async () => {
      // Every caller is composing an email. A missing name costs a line; a
      // thrown error would cost the email.
      mockRedis.getOrgName.mockRejectedValue(new Error('redis down'));

      await expect(service.name('org_1')).resolves.toBeNull();
    });

    it('does not look anything up without an id', async () => {
      await expect(service.name(null)).resolves.toBeNull();
      expect(mockRedis.getOrgName).not.toHaveBeenCalled();
    });
  });

  describe('soleOrgFor', () => {
    it('names the organisation when an account belongs to exactly one', async () => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([{ ssoOrgId: 'org_1' }]);
      mockRedis.getOrgName.mockResolvedValue('Drasken Labs');

      await expect(service.soleOrgFor('w1')).resolves.toBe('Drasken Labs');
    });

    it('stays quiet when two organisations hold the account', async () => {
      // There is no single right answer, and guessing would put the wrong
      // organisation's name in front of somebody.
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { ssoOrgId: 'org_1' },
        { ssoOrgId: 'org_2' },
      ]);

      await expect(service.soleOrgFor('w1')).resolves.toBeNull();
      expect(mockRedis.getOrgName).not.toHaveBeenCalled();
    });

    it('stays quiet when no organisation holds it', async () => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);
      await expect(service.soleOrgFor('w1')).resolves.toBeNull();
    });
  });

  describe('remember', () => {
    it('caches every named organisation it is handed', async () => {
      await service.remember([
        { id: 'org_1', name: 'Drasken Labs' },
        { id: 'org_2', name: 'Another Organisation' },
      ]);

      expect(mockRedis.setOrgName).toHaveBeenCalledWith('org_1', 'Drasken Labs');
      expect(mockRedis.setOrgName).toHaveBeenCalledWith('org_2', 'Another Organisation');
    });

    it('skips the nameless rather than caching a blank', async () => {
      await service.remember([{ id: 'org_3', name: '' }]);
      expect(mockRedis.setOrgName).not.toHaveBeenCalled();
    });

    it('never fails a login over a cache write', async () => {
      mockRedis.setOrgName.mockRejectedValue(new Error('redis down'));
      await expect(
        service.remember([{ id: 'org_1', name: 'Drasken Labs' }]),
      ).resolves.toBeUndefined();
    });
  });
});
