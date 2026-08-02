import { Test, TestingModule } from '@nestjs/testing';
import { MailNotifications } from './mail.notifications';
import { MailService } from './mail.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { orgDirectoryDouble } from 'src/org/org.test-doubles';

const RECIPIENT = { userId: 7, email: 'suraj@example.com' };

const mockMail = {
  recipientsByIds: jest.fn().mockResolvedValue([RECIPIENT]),
  recipientsForWaba: jest.fn().mockResolvedValue([RECIPIENT]),
  sendTo: jest.fn(),
  sendToAll: jest.fn(),
};
const mockPrisma = { userWhatsapp: { count: jest.fn().mockResolvedValue(2) } };
const mockOrgDirectory = orgDirectoryDouble();

/** The facts table of the single email a test sent. */
const factsOf = (fn: jest.Mock): [string, string][] => fn.mock.calls[0][1].facts;

describe('MailNotifications — naming the organisation', () => {
  let service: MailNotifications;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockMail.recipientsByIds.mockResolvedValue([RECIPIENT]);
    mockMail.recipientsForWaba.mockResolvedValue([RECIPIENT]);
    mockPrisma.userWhatsapp.count.mockResolvedValue(2);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailNotifications,
        { provide: MailService, useValue: mockMail },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrgDirectoryService, useValue: mockOrgDirectory },
      ],
    }).compile();
    service = module.get(MailNotifications);
  });

  it('names the organisation on a subscription receipt', async () => {
    // Somebody in three organisations cannot act on "your subscription
    // renewed" without being told which one it was.
    mockOrgDirectory.name.mockResolvedValue('Another Organisation');

    await service.subscriptionCharged(7, 'org_2', 'OneManPlay Games', new Date());

    expect(mockOrgDirectory.name).toHaveBeenCalledWith('org_2');
    expect(factsOf(mockMail.sendTo)).toContainEqual([
      'Organisation',
      'Another Organisation',
    ]);
  });

  it('names it first, before the account', async () => {
    mockOrgDirectory.name.mockResolvedValue('Drasken Labs');

    await service.apiKeyCreated(7, 'org_1', 'ak_123');

    expect(factsOf(mockMail.sendTo)[0]).toEqual(['Organisation', 'Drasken Labs']);
  });

  it('leaves the line out when nothing has ever told us the name', async () => {
    // A missing line reads as an email that does not mention organisations.
    // A placeholder would read as a bug.
    mockOrgDirectory.name.mockResolvedValue(null);

    await service.apiKeyRevoked(7, 'org_1', 'ak_123');

    const labels = factsOf(mockMail.sendTo).map(([label]) => label);
    expect(labels).not.toContain('Organisation');
  });

  it('names the organisation of an account only one of them holds', async () => {
    // A Meta webhook carries an account, not an organisation.
    mockOrgDirectory.soleOrgFor.mockResolvedValue('Drasken Labs');

    await service.wabaDisconnected('w1', 'OneManPlay Games');

    expect(mockOrgDirectory.soleOrgFor).toHaveBeenCalledWith('w1');
    expect(factsOf(mockMail.sendToAll)).toContainEqual([
      'Organisation',
      'Drasken Labs',
    ]);
  });

  it('stays quiet about the organisation when two of them hold the account', async () => {
    mockOrgDirectory.soleOrgFor.mockResolvedValue(null);

    await service.wabaDisconnected('w1', 'OneManPlay Games');

    const labels = factsOf(mockMail.sendToAll).map(([label]) => label);
    expect(labels).not.toContain('Organisation');
    // The account is still named — only the ambiguous part is dropped.
    expect(labels).toContain('Account');
  });

  it('names it on a connection confirmation', async () => {
    mockOrgDirectory.name.mockResolvedValue('Another Organisation');

    await service.wabaConnected(7, 'org_2', 'w1', 'OneManPlay Games');

    expect(factsOf(mockMail.sendTo)).toContainEqual([
      'Organisation',
      'Another Organisation',
    ]);
  });
});
