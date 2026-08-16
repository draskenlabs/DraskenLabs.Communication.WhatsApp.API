import { Test, TestingModule } from '@nestjs/testing';
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

  it('lists the price list without asking who is asking', async () => {
    mockPlans.findAll.mockResolvedValue([{ code: 'starter' }]);

    // No request argument at all: both routes are public by design, so there
    // is no session for the controller to read.
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
