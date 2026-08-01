import { Test, TestingModule } from '@nestjs/testing';
import { SearchService } from './search.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = {
  contact: { findMany: jest.fn(), count: jest.fn() },
  message: { findMany: jest.fn(), count: jest.fn() },
  messageTemplate: { findMany: jest.fn(), count: jest.fn() },
  waba: { findMany: jest.fn(), count: jest.fn() },
  wabaPhoneNumber: { findMany: jest.fn(), count: jest.fn() },
};

const ORG = 'org-1';

/** One clause of an `OR`, in the only shapes these tests look at. */
interface Clause {
  phone?: { contains: string };
  name?: { contains: string };
}

/**
 * The `where` a mocked Prisma call received. `mock.calls` is `any[][]`, so
 * reading it inline makes every assertion an unsafe-member-access.
 */
const whereOf = (mock: jest.Mock): { OR: Clause[] } => {
  const [args] = mock.mock.calls as [{ where: { OR: Clause[] } }][];
  return args[0].where;
};

/** Every model empty, so a test only sets up the one it cares about. */
const emptyAll = (): void => {
  for (const model of Object.values(mockPrisma)) {
    model.findMany.mockResolvedValue([]);
    model.count.mockResolvedValue(0);
  }
  // The org owns one account — templates and numbers hang off it.
  mockPrisma.waba.findMany.mockResolvedValue([{ wabaId: 'w1' }]);
};

describe('SearchService', () => {
  let service: SearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    emptyAll();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  it('returns nothing at all for a one-character query', async () => {
    // Matching on a single letter is a table scan wearing a search box.
    const result = await service.search(ORG, 'j');

    expect(result).toEqual({ query: 'j', total: 0, groups: [] });
    expect(mockPrisma.contact.findMany).not.toHaveBeenCalled();
  });

  it('groups hits by type and counts each beyond what it returns', async () => {
    mockPrisma.waba.findMany.mockResolvedValueOnce([{ wabaId: 'w1' }]);
    mockPrisma.contact.findMany.mockResolvedValue([
      {
        id: 7,
        name: 'Jane Doe',
        phone: '447911123456',
        email: 'jane@example.com',
        optedOut: false,
        createdAt: new Date('2026-01-01'),
      },
    ]);
    mockPrisma.contact.count.mockResolvedValue(37);

    const result = await service.search(ORG, 'jane');

    expect(result.total).toBe(37);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      type: 'contact',
      total: 37,
      items: [
        {
          type: 'contact',
          id: '7',
          title: 'Jane Doe',
          subtitle: '447911123456',
          description: 'jane@example.com',
        },
      ],
    });
  });

  it('omits a type that matched nothing rather than listing an empty section', async () => {
    mockPrisma.message.findMany.mockResolvedValue([
      {
        id: 3,
        to: '447911123456',
        type: 'template',
        templateName: 'order_shipped',
        metaMessageId: 'wamid.1',
        status: 'delivered',
        createdAt: new Date('2026-01-02'),
      },
    ]);
    mockPrisma.message.count.mockResolvedValue(1);

    const result = await service.search(ORG, 'order');

    expect(result.groups.map((g) => g.type)).toEqual(['message']);
  });

  it('matches a formatted phone number against the stored digits', async () => {
    await service.search(ORG, '+44 7911 123456');

    const phones = whereOf(mockPrisma.contact.findMany)
      .OR.filter((c) => c.phone)
      .map((c) => c.phone!.contains);

    // Stored as digits, so the query as typed would match nothing on its own.
    expect(phones).toContain('447911123456');
    expect(phones).toContain('+44 7911 123456');
  });

  it('does not duplicate the clause when the query is already digits', async () => {
    await service.search(ORG, '447911');

    const { OR } = whereOf(mockPrisma.contact.findMany);
    expect(OR.filter((c) => c.phone)).toHaveLength(1);
  });

  it('scopes templates and numbers to the organisation’s own accounts', async () => {
    mockPrisma.waba.findMany.mockResolvedValue([
      { wabaId: 'w1' },
      { wabaId: 'w2' },
    ]);

    await service.search(ORG, 'order');

    expect(mockPrisma.messageTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          wabaId: { in: ['w1', 'w2'] },
        }) as object,
      }),
    );
    expect(mockPrisma.wabaPhoneNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          wabaId: { in: ['w1', 'w2'] },
        }) as object,
      }),
    );
  });

  it('searches only the requested types', async () => {
    await service.search(ORG, 'jane', { types: ['contact'] });

    expect(mockPrisma.contact.findMany).toHaveBeenCalled();
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.messageTemplate.findMany).not.toHaveBeenCalled();
  });

  it('accepts the type filter as one comma-separated value', async () => {
    await service.search(ORG, 'jane', { types: ['contact,message'] });

    expect(mockPrisma.contact.findMany).toHaveBeenCalled();
    expect(mockPrisma.message.findMany).toHaveBeenCalled();
    expect(mockPrisma.waba.count).not.toHaveBeenCalled();
  });

  it('searches everything when the type filter is unrecognised', async () => {
    // Otherwise a typo reads as "no results" rather than "no such filter".
    await service.search(ORG, 'jane', { types: ['nonsense'] });

    expect(mockPrisma.contact.findMany).toHaveBeenCalled();
    expect(mockPrisma.message.findMany).toHaveBeenCalled();
  });

  it('clamps the per-type limit instead of fetching whatever was asked for', async () => {
    await service.search(ORG, 'jane', { limit: 500 });

    expect(mockPrisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
  });

  it('falls back to the phone number when a contact has no name', async () => {
    mockPrisma.contact.findMany.mockResolvedValue([
      {
        id: 1,
        name: null,
        phone: '447911123456',
        email: null,
        optedOut: true,
        createdAt: new Date('2026-01-01'),
      },
    ]);
    mockPrisma.contact.count.mockResolvedValue(1);

    const { groups } = await service.search(ORG, '4479');

    expect(groups[0].items[0]).toMatchObject({
      title: '447911123456',
      subtitle: undefined,
      badge: 'Opted out',
    });
  });

  it('names the template a message used rather than saying "template"', async () => {
    mockPrisma.message.findMany.mockResolvedValue([
      {
        id: 9,
        to: '447911123456',
        type: 'template',
        templateName: 'order_shipped',
        metaMessageId: null,
        status: 'sent',
        createdAt: new Date('2026-01-02'),
      },
    ]);
    mockPrisma.message.count.mockResolvedValue(1);

    const { groups } = await service.search(ORG, 'order');

    expect(groups[0].items[0].subtitle).toBe('order_shipped');
  });

  it('trims the query before searching and reports it as searched', async () => {
    const result = await service.search(ORG, '  jane  ');

    expect(result.query).toBe('jane');
    expect(whereOf(mockPrisma.contact.findMany).OR[0].name?.contains).toBe(
      'jane',
    );
  });
});
