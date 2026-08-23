import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { Readable } from 'stream';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { InboxMediaService } from './inbox-media.service';
import { MessageTypeEnum } from 'src/messaging/dto/send-message.dto';
import { BaseResponse } from 'src/common/responses/base-response';

const mockInbox = {
  list: jest.fn(),
  thread: jest.fn(),
  markRead: jest.fn(),
  update: jest.fn(),
  reply: jest.fn(),
};
const mockMedia = { fetch: jest.fn() };

/** A request as the auth middleware leaves it. */
const req = (over: Record<string, unknown> = {}) =>
  ({ user: { id: 3 }, orgId: 'org-a', ...over }) as never;

describe('InboxController', () => {
  let controller: InboxController;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInbox.list.mockResolvedValue(BaseResponse.paginate([], 0, 0, 1, 30));
    mockInbox.thread.mockResolvedValue({ conversation: {}, messages: [] });
    mockInbox.markRead.mockResolvedValue({ id: 7, unreadCount: 0 });
    mockInbox.update.mockResolvedValue({ id: 7, status: 'closed' });
    mockInbox.reply.mockResolvedValue({ id: 1 });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InboxController],
      providers: [
        { provide: InboxService, useValue: mockInbox },
        { provide: InboxMediaService, useValue: mockMedia },
      ],
    }).compile();
    controller = module.get(InboxController);
  });

  describe('authentication', () => {
    it('refuses a request the middleware left no user on', async () => {
      await expect(controller.list(req({ user: undefined }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses a request with no organisation', async () => {
      await expect(controller.list(req({ orgId: undefined }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('carries an API key’s WABA scope into every call', async () => {
      await controller.list(req({ apiKeyWabaId: 'w1' }));
      expect(mockInbox.list).toHaveBeenCalledWith('org-a', expect.anything(), 'w1');

      await controller.thread(req({ apiKeyWabaId: 'w1' }), 7);
      expect(mockInbox.thread).toHaveBeenCalledWith('org-a', 7, expect.anything(), 'w1');

      await controller.markRead(req({ apiKeyWabaId: 'w1' }), 7);
      expect(mockInbox.markRead).toHaveBeenCalledWith('org-a', 7, 'w1');
    });

    it('sends no scope at all on the console path', async () => {
      await controller.list(req());
      expect(mockInbox.list).toHaveBeenCalledWith('org-a', expect.anything(), undefined);
    });
  });

  describe('list', () => {
    it('passes the filters through as the service expects them', async () => {
      await controller.list(req(), '2', '50', 'open', 'true', 'Priya', 'p1', 'w1');

      expect(mockInbox.list).toHaveBeenCalledWith(
        'org-a',
        {
          page: 2,
          limit: 50,
          status: 'open',
          unreadOnly: true,
          search: 'Priya',
          phoneNumberId: 'p1',
          wabaId: 'w1',
        },
        undefined,
      );
    });

    it('passes nothing for filters that were not given', async () => {
      await controller.list(req());
      expect(mockInbox.list).toHaveBeenCalledWith('org-a', {}, undefined);
    });

    it('treats any value but "true" as not filtering to unread', async () => {
      await controller.list(req(), undefined, undefined, undefined, 'false');
      expect(mockInbox.list).toHaveBeenCalledWith('org-a', {}, undefined);
    });
  });

  describe('thread', () => {
    it('passes the cursor and page size through', async () => {
      await controller.thread(req(), 7, '2026-08-23T09:30:00Z', '20');
      expect(mockInbox.thread).toHaveBeenCalledWith(
        'org-a',
        7,
        { before: '2026-08-23T09:30:00Z', limit: 20 },
        undefined,
      );
    });

    it('wraps the thread in the standard envelope', async () => {
      const result = await controller.thread(req(), 7);
      expect(result.statusCode).toBe(200);
      expect(result.data).toEqual({ conversation: {}, messages: [] });
    });
  });

  describe('reply', () => {
    it('sends as the calling user, in the named conversation', async () => {
      const dto = { type: MessageTypeEnum.text, text: 'Hi' } as never;
      await controller.reply(req(), 7, dto);
      expect(mockInbox.reply).toHaveBeenCalledWith(3, 'org-a', 7, dto, undefined);
    });
  });

  describe('media', () => {
    const res = () => {
      const stream = { pipe: jest.fn() };
      const headers: Record<string, unknown> = {};
      return {
        stream,
        headers,
        res: {
          setHeader: (k: string, v: unknown) => {
            headers[k] = v;
          },
        } as never,
      };
    };

    it('streams the file back with the headers a viewer needs', async () => {
      const { headers, res: response } = res();
      const stream = Object.assign(Readable.from(['x']), { pipe: jest.fn() });
      mockMedia.fetch.mockResolvedValue({
        stream,
        contentType: 'image/jpeg',
        contentLength: 5,
      });

      await controller.mediaFor(req(), 9, response);

      expect(headers['Content-Type']).toBe('image/jpeg');
      expect(headers['Content-Length']).toBe(5);
      expect(stream.pipe).toHaveBeenCalled();
    });

    it('keeps one organisation’s file out of a shared cache', async () => {
      const { headers, res: response } = res();
      mockMedia.fetch.mockResolvedValue({
        stream: Object.assign(Readable.from(['x']), { pipe: jest.fn() }),
        contentType: 'image/jpeg',
      });

      await controller.mediaFor(req(), 9, response);

      expect(headers['Cache-Control']).toBe('private, max-age=300');
    });

    it('offers a document inline, under the name it arrived with', async () => {
      const { headers, res: response } = res();
      mockMedia.fetch.mockResolvedValue({
        stream: Object.assign(Readable.from(['x']), { pipe: jest.fn() }),
        contentType: 'application/pdf',
        filename: 'invoice.pdf',
      });

      await controller.mediaFor(req(), 9, response);

      expect(headers['Content-Disposition']).toBe('inline; filename="invoice.pdf"');
    });

    it('cannot have a quote in the filename break the header', async () => {
      const { headers, res: response } = res();
      mockMedia.fetch.mockResolvedValue({
        stream: Object.assign(Readable.from(['x']), { pipe: jest.fn() }),
        contentType: 'application/pdf',
        filename: 'in"voice".pdf',
      });

      await controller.mediaFor(req(), 9, response);

      expect(headers['Content-Disposition']).toBe('inline; filename="invoice.pdf"');
    });
  });
});
