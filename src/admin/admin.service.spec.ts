import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { AdminAuditService } from './admin-audit.service';
import { ConfigService } from '@nestjs/config';
import { firstArg } from 'src/common/utils/mock-args';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { AgencyService } from 'src/agency/agency.service';
import { RazorpayService } from 'src/billing/razorpay.service';
import { InvoiceService } from 'src/billing/invoice.service';
import type { AdminActor } from './admin.guard';

const ACTOR: AdminActor = { id: 1, email: 'ops@drasken.com', name: 'Ops' };

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  plan: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  subscription: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  subscriptionPayment: { findMany: jest.fn() },
  wabaOrganisation: { findMany: jest.fn() },
  waba: { findMany: jest.fn(), count: jest.fn() },
  wabaPhoneNumber: { groupBy: jest.fn(), count: jest.fn() },
  webhookEndpoint: { groupBy: jest.fn(), count: jest.fn() },
  userApiKey: { groupBy: jest.fn(), count: jest.fn() },
  organisationSettings: { findMany: jest.fn(), count: jest.fn() },
  contact: { count: jest.fn() },
  message: { count: jest.fn() },
  adminAuditLog: { findMany: jest.fn(), count: jest.fn() },
  invoice: { findMany: jest.fn(), count: jest.fn() },
};

const mockOrgDirectory = { name: jest.fn() };
const mockOrgSettings = { get: jest.fn(), clientsOf: jest.fn() };
const mockPlanLimits = { forOrg: jest.fn() };
const mockAgency = {
  convert: jest.fn(),
  attachClient: jest.fn(),
  detachClient: jest.fn(),
};
const mockAudit = { record: jest.fn() };
const mockRazorpay = { createPlan: jest.fn(), fetchPlan: jest.fn() };
// Rendering and re-sending a document is its own service's business; this
// console only decides who may ask for one, which here is anybody.
const mockInvoices = {
  toDto: jest.fn((invoice: { number: string }) => invoice),
  find: jest.fn(),
  deliver: jest.fn(),
  pdf: jest.fn(),
  filename: jest.fn(),
};

const user = (over: Record<string, unknown> = {}) => ({
  id: 2,
  email: 'someone@example.com',
  firstName: 'Some',
  lastName: 'One',
  isAdmin: false,
  createdAt: new Date('2026-01-01'),
  ...over,
});

const plan = (over: Record<string, unknown> = {}) => ({
  code: 'growth',
  name: 'Growth',
  audience: 'Growing businesses',
  price: 99_900,
  priceLabel: null,
  currency: 'INR',
  unit: '/month',
  additionalWabaPrice: 29_900,
  additionalNumberPrice: 19_900,
  includedWabas: 3,
  includedPhoneNumbersPerWaba: 1,
  includedClients: null,
  maxTeamMembers: 5,
  maxWebhookEndpoints: 5,
  maxApiKeysPerWaba: 5,
  maxContacts: 10_000,
  maxMessagesPerMinute: 500,
  historyDays: 90,
  rank: 20,
  sortOrder: 20,
  recommended: true,
  active: true,
  ctaKind: 'subscribe',
  ctaLabel: 'Choose Growth',
  ssoOrgId: null,
  razorpayPlanId: 'plan_growth',
  ...over,
});

/** Whatever the deployment has not configured falls back to a default. */
let settings: Record<string, string> = {};
const mockConfig = { get: jest.fn((key: string) => settings[key]) };

describe('AdminService', () => {
  let service: AdminService;

  beforeEach(async () => {
    jest.clearAllMocks();
    settings = {};

    mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);
    mockPrisma.organisationSettings.count.mockResolvedValue(0);
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
    mockPrisma.subscription.findMany.mockResolvedValue([]);
    mockPrisma.subscription.findFirst.mockResolvedValue(null);
    mockPrisma.subscription.groupBy.mockResolvedValue([]);
    mockPrisma.organisationSettings.findMany.mockResolvedValue([]);
    mockPrisma.contact.count.mockResolvedValue(0);
    mockPrisma.message.count.mockResolvedValue(0);
    mockPrisma.waba.count.mockResolvedValue(0);
    mockPrisma.waba.findMany.mockResolvedValue([]);
    mockPrisma.wabaPhoneNumber.count.mockResolvedValue(0);
    mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue([]);
    mockPrisma.webhookEndpoint.count.mockResolvedValue(0);
    mockPrisma.webhookEndpoint.groupBy.mockResolvedValue([]);
    mockPrisma.userApiKey.count.mockResolvedValue(0);
    mockPrisma.userApiKey.groupBy.mockResolvedValue([]);
    mockPrisma.plan.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockOrgDirectory.name.mockResolvedValue(null);
    mockOrgSettings.get.mockImplementation((id: string) =>
      Promise.resolve({ ssoOrgId: id, isAgency: false, agencyOrgId: null }),
    );
    mockOrgSettings.clientsOf.mockResolvedValue([]);
    mockPlanLimits.forOrg.mockResolvedValue({ planCode: null, contacts: null });
    mockAudit.record.mockResolvedValue(undefined);
    mockRazorpay.createPlan.mockResolvedValue({ id: 'plan_created' });
    mockRazorpay.fetchPlan.mockResolvedValue({
      id: 'plan_other',
      item: { amount: 99_900, currency: 'INR' },
    });
    mockInvoices.toDto.mockImplementation(
      (invoice: { number: string }) => invoice,
    );
    mockInvoices.find.mockResolvedValue(null);
    mockInvoices.deliver.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrgDirectoryService, useValue: mockOrgDirectory },
        { provide: OrganisationSettingsService, useValue: mockOrgSettings },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: AgencyService, useValue: mockAgency },
        { provide: AdminAuditService, useValue: mockAudit },
        { provide: RazorpayService, useValue: mockRazorpay },
        { provide: InvoiceService, useValue: mockInvoices },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get(AdminService);
  });

  describe('the organisation index', () => {
    it('finds an organisation by any trace of it, not only by a subscription', async () => {
      // Organisations live in the SSO — there is no table. One is real here the
      // moment it connects an account, subscribes, or gets settings written.
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { ssoOrgId: 'org_connected', wabaId: 'waba_1', createdAt: new Date() },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        { ssoOrgId: 'org_paying' },
      ]);
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        { ssoOrgId: 'org_agency' },
      ]);

      const { organisations, total } = await service.organisations({});

      expect(total).toBe(3);
      expect(organisations.map((o) => o.ssoOrgId).sort()).toEqual([
        'org_agency',
        'org_connected',
        'org_paying',
      ]);
    });

    it('searches the name as well as the id', async () => {
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        { ssoOrgId: 'org_1' },
        { ssoOrgId: 'org_2' },
      ]);
      mockOrgDirectory.name.mockImplementation((id: string) =>
        Promise.resolve(id === 'org_1' ? 'Kettle Coffee' : 'Loom & Thread'),
      );

      const { organisations } = await service.organisations({
        search: 'kettle',
      });

      expect(organisations).toHaveLength(1);
      expect(organisations[0].name).toBe('Kettle Coffee');
    });

    it('names who pays for a client, rather than leaving an opaque id', async () => {
      // "Who pays for this" is the question an operator opens a client's row
      // with, and `org_9f2…` is not an answer to it.
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        { ssoOrgId: 'org_client' },
      ]);
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 7,
        status: 'active',
        currentStart: new Date(),
        currentEnd: new Date(Date.now() + 86_400_000),
        cancelAtCycleEnd: false,
        createdAt: new Date(),
        razorpaySubscriptionId: null,
        payerOrgId: 'org_agency',
        pendingPlanAt: null,
        plan: {
          code: 'growth',
          name: 'Growth',
          price: 99_900,
          currency: 'INR',
        },
        pendingPlan: null,
      });
      mockOrgDirectory.name.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'org_agency' ? 'Bright Agency' : 'Kettle Coffee',
        ),
      );

      const { organisations } = await service.organisations({});

      expect(organisations[0]).toEqual(
        expect.objectContaining({
          payerOrgId: 'org_agency',
          payerName: 'Bright Agency',
          planName: 'Growth',
        }),
      );
    });

    it('leaves the payer empty for an organisation that pays for itself', async () => {
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        { ssoOrgId: 'org_self' },
      ]);
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 8,
        status: 'active',
        currentStart: new Date(),
        currentEnd: new Date(Date.now() + 86_400_000),
        cancelAtCycleEnd: false,
        createdAt: new Date(),
        razorpaySubscriptionId: 'sub_1',
        payerOrgId: null,
        pendingPlanAt: null,
        plan: {
          code: 'growth',
          name: 'Growth',
          price: 99_900,
          currency: 'INR',
        },
        pendingPlan: null,
      });

      const { organisations } = await service.organisations({});

      expect(organisations[0].payerOrgId).toBeNull();
      expect(organisations[0].payerName).toBeNull();
    });

    it('404s for an organisation we have no trace of', async () => {
      await expect(service.organisation('org_nobody')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('writing a new plan', () => {
    const dto = {
      code: 'agency-growth',
      name: 'Agency Growth',
      audience: 'Agencies with a handful of clients.',
      price: 499_900,
      includedClients: 10,
      maxContacts: 10_000,
    };

    beforeEach(() => {
      mockPrisma.plan.findUnique.mockResolvedValue(null);
      mockPrisma.plan.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => Promise.resolve(data),
      );
      mockPrisma.plan.findMany.mockResolvedValue([
        plan({ code: 'agency-growth', name: 'Agency Growth' }),
      ]);
    });

    it('creates the provider plan and the row together', async () => {
      // A row with a price and no provider plan shows as sellable and refuses
      // every attempt to buy it.
      await service.createPlan(ACTOR, dto);

      expect(mockRazorpay.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 499_900, currency: 'INR' }),
      );
      const [{ data }] = mockPrisma.plan.create.mock.calls[0] as [
        { data: { razorpayPlanId: string; ctaKind: string } },
      ];
      expect(data.razorpayPlanId).toBe('plan_created');
      expect(data.ctaKind).toBe('subscribe');
    });

    it('leaves nothing behind when the provider refuses', async () => {
      // The provider plan is created first for exactly this reason.
      mockRazorpay.createPlan.mockRejectedValue(new Error('gateway down'));

      await expect(service.createPlan(ACTOR, dto)).rejects.toThrow();
      expect(mockPrisma.plan.create).not.toHaveBeenCalled();
    });

    it('needs no provider plan for a quoted tier', async () => {
      await service.createPlan(ACTOR, {
        code: 'enterprise',
        name: 'Enterprise',
        audience: 'Talk to us.',
        priceLabel: 'Custom',
        ctaKind: 'contact',
      });

      expect(mockRazorpay.createPlan).not.toHaveBeenCalled();
      const [{ data }] = mockPrisma.plan.create.mock.calls[0] as [
        { data: { razorpayPlanId: string | null; price: number | null } },
      ];
      expect(data.razorpayPlanId).toBeNull();
      expect(data.price).toBeNull();
    });

    it('refuses a sellable plan with no price', async () => {
      await expect(
        service.createPlan(ACTOR, {
          code: 'free',
          name: 'Free',
          audience: 'Nobody.',
          ctaKind: 'subscribe',
        }),
      ).rejects.toThrow(/needs a price/);
    });

    it('refuses a quoted plan with nothing on the card', async () => {
      await expect(
        service.createPlan(ACTOR, {
          code: 'blank',
          name: 'Blank',
          audience: 'Nobody.',
          ctaKind: 'contact',
        }),
      ).rejects.toThrow(/priceLabel/);
    });

    it('refuses a code already in use', async () => {
      mockPrisma.plan.findUnique.mockResolvedValue({ code: 'growth' });

      await expect(
        service.createPlan(ACTOR, { ...dto, code: 'growth' }),
      ).rejects.toThrow(/already exists/);
      expect(mockRazorpay.createPlan).not.toHaveBeenCalled();
    });

    it('scopes a private plan to the organisation it was written for', async () => {
      await service.createPlan(ACTOR, { ...dto, ssoOrgId: 'org_northwind' });

      const [{ data }] = mockPrisma.plan.create.mock.calls[0] as [
        { data: { ssoOrgId: string } },
      ];
      expect(data.ssoOrgId).toBe('org_northwind');

      const [, entry] = mockAudit.record.mock.calls[0] as [
        unknown,
        { summary: string },
      ];
      expect(entry.summary).toContain('private to org_northwind');
    });

    it('never makes a new plan the recommended one', async () => {
      // A new tier becoming the highlighted one is a separate decision, made
      // with the price list in front of you.
      await service.createPlan(ACTOR, dto);

      const [{ data }] = mockPrisma.plan.create.mock.calls[0] as [
        { data: { recommended: boolean } },
      ];
      expect(data.recommended).toBe(false);
    });
  });

  describe('the plan editor', () => {
    it('records what changed, not merely that something did', async () => {
      // "Who turned this customer's limit up" is the question this gets asked,
      // and it cannot be answered by a row that says only `plan.updated`.
      mockPrisma.plan.findUnique.mockResolvedValue(plan());
      mockPrisma.plan.findMany.mockResolvedValue([
        plan({ maxContacts: 25_000 }),
      ]);
      mockPrisma.plan.update.mockResolvedValue(plan());

      await service.updatePlan(ACTOR, 'growth', { maxContacts: 25_000 });

      expect(mockPrisma.plan.update).toHaveBeenCalledWith({
        where: { code: 'growth' },
        data: { maxContacts: 25_000 },
      });
      const [, entry] = mockAudit.record.mock.calls[0] as [
        unknown,
        { before: unknown; after: unknown; action: string },
      ];
      expect(entry.action).toBe('plan.updated');
      expect(entry.before).toEqual({ maxContacts: 10_000 });
      expect(entry.after).toEqual({ maxContacts: 25_000 });
    });

    it('writes nothing when nothing actually differs', async () => {
      // Saving a form untouched should not fill the audit log with noise.
      mockPrisma.plan.findUnique.mockResolvedValue(plan());
      mockPrisma.plan.findMany.mockResolvedValue([plan()]);

      await service.updatePlan(ACTOR, 'growth', { maxContacts: 10_000 });

      expect(mockPrisma.plan.update).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('never lets a price through, however it is sent', async () => {
      // A Razorpay plan is immutable and a subscription is charged against the
      // one it was created on. Editing the amount here would change what the
      // price list says without changing what anybody is billed.
      mockPrisma.plan.findUnique.mockResolvedValue(plan());
      mockPrisma.plan.findMany.mockResolvedValue([plan()]);

      await service.updatePlan(ACTOR, 'growth', {
        price: 149_900,
        currency: 'USD',
      } as never);

      // The provider plan is immutable and a subscription is charged against
      // the one it was created on, so an amount here would change what the
      // price list says without changing what anybody is billed. Repointing
      // the tier at a different provider plan is the supported move, and it
      // is checked separately.
      expect(mockPrisma.plan.update).not.toHaveBeenCalled();
    });

    it('clears the old recommendation when a new one is set', async () => {
      // Two recommended tiers is a pricing page that recommends nothing.
      mockPrisma.plan.findUnique.mockResolvedValue(
        plan({ recommended: false }),
      );
      mockPrisma.plan.findMany.mockResolvedValue([plan()]);
      mockPrisma.plan.update.mockResolvedValue(plan());

      await service.updatePlan(ACTOR, 'growth', { recommended: true });

      expect(mockPrisma.plan.updateMany).toHaveBeenCalledWith({
        where: { recommended: true, NOT: { code: 'growth' } },
        data: { recommended: false },
      });
    });

    it('points a tier at another provider plan once it agrees on the amount', async () => {
      mockPrisma.plan.findUnique.mockResolvedValue(plan());
      mockPrisma.plan.findMany.mockResolvedValue([plan()]);
      mockPrisma.plan.update.mockResolvedValue(plan());

      await service.updatePlan(ACTOR, 'growth', {
        razorpayPlanId: 'plan_other',
      });

      expect(mockRazorpay.fetchPlan).toHaveBeenCalledWith('plan_other');
      expect(mockPrisma.plan.update).toHaveBeenCalledWith({
        where: { code: 'growth' },
        data: { razorpayPlanId: 'plan_other' },
      });
    });

    it('refuses a provider plan charging something else entirely', async () => {
      // One typo, and the first anybody knows is a customer's bank statement.
      mockPrisma.plan.findUnique.mockResolvedValue(plan());
      mockPrisma.plan.findMany.mockResolvedValue([plan()]);
      mockRazorpay.fetchPlan.mockResolvedValue({
        id: 'plan_expensive',
        item: { amount: 999_900, currency: 'INR' },
      });

      await expect(
        service.updatePlan(ACTOR, 'growth', {
          razorpayPlanId: 'plan_expensive',
        }),
      ).rejects.toThrow(/charges 999900 and Growth is priced at 99900/);
      expect(mockPrisma.plan.update).not.toHaveBeenCalled();
    });

    it('refuses a provider plan that does not resolve', async () => {
      mockPrisma.plan.findUnique.mockResolvedValue(plan());
      mockPrisma.plan.findMany.mockResolvedValue([plan()]);
      mockRazorpay.fetchPlan.mockResolvedValue(null);

      await expect(
        service.updatePlan(ACTOR, 'growth', { razorpayPlanId: 'plan_typo' }),
      ).rejects.toThrow(/Nothing has been changed/);
      expect(mockPrisma.plan.update).not.toHaveBeenCalled();
    });

    it('refuses a provider plan in another currency', async () => {
      mockPrisma.plan.findUnique.mockResolvedValue(plan());
      mockPrisma.plan.findMany.mockResolvedValue([plan()]);
      mockRazorpay.fetchPlan.mockResolvedValue({
        id: 'plan_usd',
        item: { amount: 99_900, currency: 'USD' },
      });

      await expect(
        service.updatePlan(ACTOR, 'growth', { razorpayPlanId: 'plan_usd' }),
      ).rejects.toThrow(/is in USD and Growth is in INR/);
    });

    it('asks the provider nothing when the id has not changed', async () => {
      mockPrisma.plan.findUnique.mockResolvedValue(
        plan({ razorpayPlanId: 'plan_growth' }),
      );
      mockPrisma.plan.findMany.mockResolvedValue([plan()]);

      await service.updatePlan(ACTOR, 'growth', {
        razorpayPlanId: 'plan_growth',
      });

      expect(mockRazorpay.fetchPlan).not.toHaveBeenCalled();
    });

    it('404s for a plan that does not exist', async () => {
      mockPrisma.plan.findUnique.mockResolvedValue(null);

      await expect(
        service.updatePlan(ACTOR, 'nonsense', { active: false }),
      ).rejects.toThrow(NotFoundException);
    });

    it('calls a tier with no Razorpay plan unsellable, whatever the price list says', async () => {
      mockPrisma.plan.findMany.mockResolvedValue([
        plan({ razorpayPlanId: null }),
      ]);

      const [row] = await service.plans();

      expect(row.sellable).toBe(false);
      // Said plainly rather than left to be inferred: the editor offers this
      // field, and an operator fixing an unsellable tier has to see that it is
      // pointed at nothing.
      expect(row.razorpayPlanId).toBeNull();
    });

    it('shows which provider plan a sellable tier is pointed at', async () => {
      mockPrisma.plan.findMany.mockResolvedValue([
        plan({ razorpayPlanId: 'plan_growth' }),
      ]);

      const [row] = await service.plans();

      expect(row.razorpayPlanId).toBe('plan_growth');
      expect(row.sellable).toBe(true);
    });
  });

  describe('invoices', () => {
    beforeEach(() => {
      mockPrisma.invoice.findMany.mockResolvedValue([
        { number: 'INV-WAC-2627-0001' },
      ]);
      mockPrisma.invoice.count.mockResolvedValue(1);
    });

    it('finds a document by its number, an email or a payment id', async () => {
      // Which is what "somebody wrote in asking about INV-WAC-2627-0412"
      // actually needs — the number is often the only thing they have.
      await service.invoices({ search: 'ada@example.com' });

      const [{ where }] = mockPrisma.invoice.findMany.mock.calls[0] as [
        { where: { AND: [{ OR: Record<string, unknown>[] }] } },
      ];
      const fields = where.AND[0].OR.flatMap((clause) => Object.keys(clause));
      expect(fields).toEqual(
        expect.arrayContaining([
          'number',
          'billedToEmail',
          'razorpayPaymentId',
        ]),
      );
    });

    it('shows a client what bought its month, not only what it was charged', async () => {
      // An agency's client is charged nothing and is still on an invoice.
      // Narrowing to `ssoOrgId` alone would show it an empty history.
      await service.invoices({ ssoOrgId: 'org_kettle' });

      const [{ where }] = mockPrisma.invoice.findMany.mock.calls[0] as [
        { where: { OR: Record<string, unknown>[] } },
      ];
      expect(where.OR).toEqual([
        { ssoOrgId: 'org_kettle' },
        { lines: { some: { ssoOrgId: 'org_kettle' } } },
      ]);
    });

    it('counts what was raised and never reached anybody', async () => {
      // The one figure on that screen that is a job rather than a record.
      mockPrisma.invoice.count
        .mockResolvedValueOnce(12)
        .mockResolvedValueOnce(3);

      const page = await service.invoices({});

      expect(page.undelivered).toBe(3);
    });

    it('404s for a number that does not exist', async () => {
      mockInvoices.find.mockResolvedValue(null);

      await expect(service.invoice('INV-WAC-2627-9999')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('re-sends to the address on the document, not one supplied with the request', async () => {
      // An operator-triggered send to an arbitrary address is a way to mail
      // somebody else's invoice anywhere.
      mockInvoices.find.mockResolvedValue({
        number: 'INV-WAC-2627-0001',
        billedToEmail: 'ada@example.com',
      });

      const result = await service.resendInvoice(ACTOR, 'INV-WAC-2627-0001');

      expect(result).toEqual({ sent: true, to: 'ada@example.com' });
      expect(mockInvoices.deliver).toHaveBeenCalledWith(
        expect.objectContaining({ number: 'INV-WAC-2627-0001' }),
      );
    });

    it('records a re-send, since it puts a document in somebody’s inbox', async () => {
      mockInvoices.find.mockResolvedValue({
        number: 'INV-WAC-2627-0001',
        billedToEmail: 'ada@example.com',
      });

      await service.resendInvoice(ACTOR, 'INV-WAC-2627-0001');

      expect(mockAudit.record).toHaveBeenCalledWith(
        ACTOR,
        expect.objectContaining({
          action: 'invoice.resend',
          targetType: 'invoice',
          targetId: 'INV-WAC-2627-0001',
        }),
      );
    });
  });

  describe('granting access to this console', () => {
    it('records who granted it', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user());
      mockPrisma.user.update.mockResolvedValue(user({ isAdmin: true }));

      await service.setAdmin(ACTOR, 2, true);

      const [actor, entry] = mockAudit.record.mock.calls[0] as [
        AdminActor,
        { action: string },
      ];
      expect(actor).toBe(ACTOR);
      expect(entry.action).toBe('admin.granted');
    });

    it('will not let an operator demote themselves', async () => {
      // One click, and the recovery is a database session.
      mockPrisma.user.findUnique.mockResolvedValue(
        user({ id: 1, isAdmin: true }),
      );

      await expect(service.setAdmin(ACTOR, 1, false)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('will not remove the last admin', async () => {
      // However it is attempted, an estate with nobody who can administer it
      // is the failure worth refusing.
      mockPrisma.user.findUnique.mockResolvedValue(
        user({ id: 2, isAdmin: true }),
      );
      mockPrisma.user.count.mockResolvedValue(0);

      await expect(service.setAdmin(ACTOR, 2, false)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('allows a demotion while somebody else still has it', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        user({ id: 2, isAdmin: true }),
      );
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.user.update.mockResolvedValue(user({ id: 2, isAdmin: false }));

      await expect(service.setAdmin(ACTOR, 2, false)).resolves.toMatchObject({
        isAdmin: false,
      });
    });

    it('does not search on a fragment too short to mean anything', async () => {
      // "a" would return the first ten accounts in the database. This is not a
      // staff directory.
      await expect(service.findUsers('a')).resolves.toEqual([]);
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('agency changes', () => {
    it('names the operator rather than a shared token', async () => {
      mockAgency.convert.mockResolvedValue({
        ssoOrgId: 'org_1',
        isAgency: true,
      });

      await service.convert(ACTOR, 'org_1', true);

      expect(mockAgency.convert).toHaveBeenCalledWith('org_1', true, ACTOR.id);
    });

    it('records the billing consequence, not just the relationship', async () => {
      // This is the line somebody reads when they ask why an invoice moved.
      mockAgency.attachClient.mockResolvedValue({ ssoOrgId: 'org_client' });

      await service.attachClient(ACTOR, 'org_agency', 'org_client', 'Kettle');

      const entry = entryOf(mockAudit.record.mock.calls[0]);
      expect(entry.summary).toContain('org_agency now pays for org_client');
    });
  });

  describe('the overview', () => {
    it('counts money that should be arriving and is not', async () => {
      mockPrisma.subscription.groupBy.mockResolvedValue([
        { status: 'active', _count: { _all: 12 } },
        { status: 'pending', _count: { _all: 2 } },
        { status: 'halted', _count: { _all: 1 } },
        { status: 'created', _count: { _all: 3 } },
      ]);

      const overview = await service.overview();

      expect(overview.activeSubscriptions).toBe(12);
      expect(overview.atRisk).toEqual({
        pending: 2,
        halted: 1,
        // Chosen and never paid for: the quietest way to lose a sale.
        neverAuthorised: 3,
      });
    });

    it('counts a quoted plan as no revenue rather than inventing one', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([
        { plan: { price: 99_900, currency: 'INR' } },
        { plan: { price: null, currency: 'INR' } },
      ]);

      const overview = await service.overview();

      expect(overview.mrr).toBe(99_900);
    });
  });

  describe('revenue and analytics', () => {
    /** 29 Aug 2026, 18:30 UTC — which is 00:00 on the 30th in Kolkata. */
    const ACROSS_MIDNIGHT = new Date('2026-08-29T18:30:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-30T09:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('counts a payment by the day it fell on locally, not in UTC', async () => {
      // 18:30 UTC on the 29th is 00:00 IST on the 30th. Counted from UTC it
      // would be filed under yesterday and today's figure would be wrong.
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        {
          amount: 117_882,
          currency: 'INR',
          paidAt: ACROSS_MIDNIGHT,
          createdAt: ACROSS_MIDNIGHT,
        },
      ]);

      const { revenue } = await service.overview();

      expect(revenue.today).toBe(117_882);
      expect(revenue.month).toBe(117_882);
    });

    it('counts the financial year from 1 April, not 1 January', async () => {
      // "This year" to somebody reconciling revenue is the year they file for.
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        {
          amount: 50_000,
          currency: 'INR',
          paidAt: new Date('2026-05-02T06:00:00.000Z'),
          createdAt: new Date('2026-05-02T06:00:00.000Z'),
        },
      ]);

      const { revenue } = await service.overview();

      // In the year, but neither today nor this month.
      expect(revenue.year).toBe(50_000);
      expect(revenue.month).toBe(0);
      expect(revenue.today).toBe(0);
      // And the query asked for nothing before 1 April.
      const { where } = firstArg<{
        where: { OR: [{ paidAt: { gte: Date } }] };
      }>(mockPrisma.subscriptionPayment.findMany);
      expect(where.OR[0].paidAt.gte.toISOString()).toBe(
        '2026-03-31T18:30:00.000Z',
      );
    });

    it('falls back to when a payment was recorded if it has no paid date', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        {
          amount: 999,
          currency: 'INR',
          paidAt: null,
          createdAt: ACROSS_MIDNIGHT,
        },
      ]);

      expect((await service.overview()).revenue.today).toBe(999);
    });

    it('counts people and agencies', async () => {
      mockPrisma.user.count.mockResolvedValue(42);
      mockPrisma.organisationSettings.count.mockResolvedValue(3);

      const overview = await service.overview();

      expect(overview.users).toBe(42);
      expect(overview.agencies).toBe(3);
    });

    it('returns every day in the range, including the empty ones', async () => {
      // A series with gaps draws a chart that lies about its own shape.
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);

      const analytics = await service.analytics(7);

      expect(analytics.days).toBe(7);
      expect(analytics.registrations).toHaveLength(7);
      expect(analytics.registrations.every((p) => p.value === 0)).toBe(true);
      // Inclusive of today: seven days is today and the six before it.
      expect(analytics.registrations.at(-1)?.date).toBe('2026-08-30');
      expect(analytics.registrations[0].date).toBe('2026-08-24');
    });

    it('buckets registrations and money onto the right days', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { createdAt: ACROSS_MIDNIGHT },
        { createdAt: new Date('2026-08-28T10:00:00.000Z') },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        { createdAt: ACROSS_MIDNIGHT },
      ]);
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        {
          amount: 500,
          currency: 'INR',
          paidAt: ACROSS_MIDNIGHT,
          createdAt: ACROSS_MIDNIGHT,
        },
        {
          amount: 250,
          currency: 'INR',
          paidAt: ACROSS_MIDNIGHT,
          createdAt: ACROSS_MIDNIGHT,
        },
      ]);

      const analytics = await service.analytics(7);
      const on = (series: { date: string; value: number }[], date: string) =>
        series.find((p) => p.date === date)?.value;

      expect(on(analytics.registrations, '2026-08-30')).toBe(1);
      expect(on(analytics.registrations, '2026-08-28')).toBe(1);
      expect(on(analytics.subscriptions, '2026-08-30')).toBe(1);
      // Summed, not counted.
      expect(on(analytics.revenue, '2026-08-30')).toBe(750);
    });

    it('refuses a range that would ask for the whole database', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);

      expect((await service.analytics(100_000)).days).toBe(365);
      expect((await service.analytics(0)).days).toBe(1);
    });
  });

  describe('the user directory', () => {
    beforeEach(() => {
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: 7,
          email: 'ada@example.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          isAdmin: false,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      mockPrisma.organisationSettings.findMany.mockResolvedValue([]);
    });

    it('names the organisations a person has been seen in', async () => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { userId: 7, ssoOrgId: 'org_1', orgName: 'Acme Retail' },
      ]);

      const { users } = await service.users({});

      expect(users[0].email).toBe('ada@example.com');
      expect(users[0].organisations).toEqual([
        { ssoOrgId: 'org_1', name: 'Acme Retail', wabas: 1, isAgency: false },
      ]);
    });

    it('counts accounts rather than listing an organisation twice', async () => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { userId: 7, ssoOrgId: 'org_1', orgName: 'Acme Retail' },
        { userId: 7, ssoOrgId: 'org_1', orgName: 'Acme Retail' },
      ]);

      const { users } = await service.users({});

      expect(users[0].organisations).toHaveLength(1);
      expect(users[0].organisations[0].wabas).toBe(2);
    });

    it('takes a name from a later row where an older one has none', async () => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { userId: 7, ssoOrgId: 'org_1', orgName: null },
        { userId: 7, ssoOrgId: 'org_1', orgName: 'Acme Retail' },
      ]);

      const { users } = await service.users({});

      expect(users[0].organisations[0].name).toBe('Acme Retail');
    });

    it('marks an organisation that manages clients', async () => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { userId: 7, ssoOrgId: 'org_agency', orgName: 'Northwind' },
      ]);
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        { ssoOrgId: 'org_agency' },
      ]);

      const { users } = await service.users({});

      expect(users[0].organisations[0].isAgency).toBe(true);
    });

    it('leaves somebody who has connected nothing with no organisations', async () => {
      // Rather than inventing a membership we have no record of.
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);

      const { users } = await service.users({});

      expect(users[0].organisations).toEqual([]);
    });

    it('pages, and never asks for more than a page at a time', async () => {
      mockPrisma.user.count.mockResolvedValue(120);
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);

      const page = await service.users({ page: 3 });

      expect(page.total).toBe(120);
      expect(page.page).toBe(3);
      expect(page.totalPages).toBe(5);
      const { skip, take } = firstArg<{ skip: number; take: number }>(
        mockPrisma.user.findMany,
      );
      expect(skip).toBe(50);
      expect(take).toBe(25);
    });
  });

  describe('the agency list', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockOrgDirectory.name.mockImplementation((id: string) =>
        Promise.resolve(id === 'org_agency' ? 'Northwind Digital' : null),
      );
    });

    it('lists an agency with the clients under it', async () => {
      mockPrisma.organisationSettings.findMany
        .mockResolvedValueOnce([
          { ssoOrgId: 'org_agency', convertedBy: null, convertedAt: null },
        ])
        .mockResolvedValueOnce([
          {
            ssoOrgId: 'org_kettle',
            agencyOrgId: 'org_agency',
            clientName: 'Kettle Coffee',
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        ]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        {
          ssoOrgId: 'org_kettle',
          status: 'active',
          plan: {
            code: 'growth',
            name: 'Growth',
            price: 84_900,
            currency: 'INR',
          },
        },
      ]);

      const [agency] = await service.agencies();

      expect(agency.name).toBe('Northwind Digital');
      expect(agency.clientCount).toBe(1);
      expect(agency.monthly).toBe(84_900);
      expect(agency.clients[0]).toMatchObject({
        name: 'Kettle Coffee',
        planName: 'Growth',
        status: 'active',
      });
    });

    it('counts a client on a quoted tier as nothing rather than inventing a price', async () => {
      mockPrisma.organisationSettings.findMany
        .mockResolvedValueOnce([
          { ssoOrgId: 'org_agency', convertedBy: null, convertedAt: null },
        ])
        .mockResolvedValueOnce([
          {
            ssoOrgId: 'org_quoted',
            agencyOrgId: 'org_agency',
            clientName: 'Quoted Co',
            createdAt: new Date(),
          },
        ]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        {
          ssoOrgId: 'org_quoted',
          status: 'active',
          plan: {
            code: 'custom',
            name: 'Custom',
            price: null,
            currency: 'INR',
          },
        },
      ]);

      const [agency] = await service.agencies();

      expect(agency.monthly).toBe(0);
      expect(agency.clients[0].price).toBeNull();
    });

    it('shows a client with no subscription rather than dropping it', async () => {
      // Taken on and not yet paid for is exactly what somebody is looking for.
      mockPrisma.organisationSettings.findMany
        .mockResolvedValueOnce([
          { ssoOrgId: 'org_agency', convertedBy: null, convertedAt: null },
        ])
        .mockResolvedValueOnce([
          {
            ssoOrgId: 'org_new',
            agencyOrgId: 'org_agency',
            clientName: null,
            createdAt: new Date(),
          },
        ]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      const [agency] = await service.agencies();

      expect(agency.clients).toHaveLength(1);
      expect(agency.clients[0].status).toBeNull();
      expect(agency.clients[0].planName).toBeNull();
    });

    it('says nothing at all where no organisation is an agency', async () => {
      mockPrisma.organisationSettings.findMany.mockResolvedValueOnce([]);

      expect(await service.agencies()).toEqual([]);
      // And does not go looking for clients of nobody.
      expect(mockPrisma.subscription.findMany).not.toHaveBeenCalled();
    });
  });
});

/** The entry from a `record(actor, entry)` call — the second argument. */
function entryOf(call: unknown[]): { summary: string; action: string } {
  return call[1] as { summary: string; action: string };
}
