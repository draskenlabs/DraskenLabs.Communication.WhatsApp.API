import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';
import { MailNotifications } from './mail.notifications';

const mockMail = { enabled: true };

const mockNotifications = {
  supportRequest: jest.fn(),
  supportAcknowledgement: jest.fn(),
};

const config = new Map<string, string>([
  ['SUPPORT_EMAIL', 'support@draskenlabs.com'],
]);

const mockConfig = { get: (key: string) => config.get(key) };

const REQUEST = {} as Request;

const dto = {
  email: 'ada@example.com',
  subject: 'Cannot send a template',
  message: 'It fails with 132000 every time.',
};

describe('MailController — support', () => {
  let controller: MailController;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockMail.enabled = true;
    mockNotifications.supportRequest.mockResolvedValue(true);
    mockNotifications.supportAcknowledgement.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailController,
        { provide: MailService, useValue: mockMail },
        { provide: MailNotifications, useValue: mockNotifications },
        { provide: PrismaService, useValue: {} },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    controller = module.get<MailController>(MailController);
  });

  it('delivers to the topic-tagged mailbox and confirms receipt', async () => {
    const result = await controller.support(REQUEST, {
      ...dto,
      topic: 'security',
    });

    expect(result.received).toBe(true);
    expect(result.message).toContain('one business day');

    expect(mockNotifications.supportRequest).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'support+security@draskenlabs.com' }),
    );
    expect(mockNotifications.supportAcknowledgement).toHaveBeenCalled();
  });

  it('does not claim to have a message that was never delivered', async () => {
    // The old answer was "We have your message and will reply within one
    // business day" whatever happened to the send.
    mockNotifications.supportRequest.mockResolvedValue(false);

    await expect(controller.support(REQUEST, dto)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('names a mailbox to write to when it could not deliver', async () => {
    mockNotifications.supportRequest.mockResolvedValue(false);

    await expect(controller.support(REQUEST, dto)).rejects.toThrow(
      /support@draskenlabs\.com/,
    );
  });

  it('does not acknowledge a message that did not arrive', async () => {
    mockNotifications.supportRequest.mockResolvedValue(false);

    await expect(controller.support(REQUEST, dto)).rejects.toThrow();
    expect(mockNotifications.supportAcknowledgement).not.toHaveBeenCalled();
  });

  it('says so plainly when email is switched off entirely', async () => {
    mockMail.enabled = false;

    await expect(controller.support(REQUEST, dto)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(mockNotifications.supportRequest).not.toHaveBeenCalled();
  });

  it('rejects a topic with no mailbox behind it', async () => {
    config.delete('SUPPORT_EMAIL');

    await expect(controller.support(REQUEST, dto)).rejects.toThrow(
      BadRequestException,
    );

    config.set('SUPPORT_EMAIL', 'support@draskenlabs.com');
  });
});
