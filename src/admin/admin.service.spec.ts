import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { AdminAuditService } from './admin-audit.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { AgencyService } from 'src/agency/agency.service';
import { RazorpayService } from 'src/billing/razorpay.service';
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
  organisationSettings: { findMany: jest.fn() },
  contact: { count: jest.fn() },
  message: { count: jest.fn() },
  adminAuditLog: { findMany: jest.fn(), count: jest.fn() },
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

describe('AdminService', () => {
  let service: AdminService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);
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
});

/** The entry from a `record(actor, entry)` call — the second argument. */
function entryOf(call: unknown[]): { summary: string; action: string } {
  return call[1] as { summary: string; action: string };
}
