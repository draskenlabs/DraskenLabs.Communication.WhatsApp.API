import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

const mockPlans = { findAll: jest.fn(), findByCode: jest.fn() };

describe('PlansController', () => {
  let controller: PlansController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlansController],
      providers: [{ provide: PlansService, useValue: mockPlans }],
    }).compile();
    controller = module.get(PlansController);
  });

  it('lists the published price list without asking who is asking', async () => {
    mockPlans.findAll.mockResolvedValue([{ code: 'starter' }]);

    // No request argument at all: the published list is public by design, so
    // there is no session for the controller to read.
    const plans = await controller.findAll();

    expect(plans).toHaveLength(1);
    expect(mockPlans.findAll).toHaveBeenCalledWith();
  });

  it('passes the code through for a single plan', async () => {
    mockPlans.findByCode.mockResolvedValue({ code: 'growth' });

    await controller.findOne('growth');

    expect(mockPlans.findByCode).toHaveBeenCalledWith('growth');
  });
});

describe('PlansController — /plans/mine', () => {
  let controller: PlansController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlansController],
      providers: [{ provide: PlansService, useValue: mockPlans }],
    }).compile();
    controller = module.get(PlansController);
  });

  it('scopes the list to the caller\u2019s organisation', async () => {
    mockPlans.findAll.mockResolvedValue([{ code: 'custom' }]);

    await controller.findMine({ orgId: 'sso_org_7' } as never);

    expect(mockPlans.findAll).toHaveBeenCalledWith('sso_org_7');
  });

  it('refuses a token carrying no organisation', async () => {
    // Falling back to the public list here would be worse than an error: the
    // console would quietly render a price list missing the plan the customer
    // actually pays, and they would have no way to tell.
    await expect(controller.findMine({} as never)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mockPlans.findAll).not.toHaveBeenCalled();
  });
});
