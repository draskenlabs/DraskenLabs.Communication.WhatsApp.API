import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { Readable } from 'stream';
import { InboxMediaService } from './inbox-media.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { EncryptionService } from 'src/common/services/crypto.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = { inboundMessage: { findFirst: jest.fn() } };
const mockRedis = {
  getPhoneCache: jest.fn(),
  getMediaUrl: jest.fn(),
  setMediaUrl: jest.fn(),
};
const mockEncryption = { decrypt: jest.fn().mockReturnValue('plain_token') };

const inboundRow = (over: Record<string, unknown> = {}) => ({
  id: 9,
  wabaId: 'w1',
  phoneNumberId: 'p1',
  type: 'image',
  payload: { id: 'MEDIA1', mime_type: 'image/jpeg' },
  ...over,
});

describe('InboxMediaService', () => {
  let service: InboxMediaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.getMediaUrl.mockResolvedValue(null);
    mockRedis.setMediaUrl.mockResolvedValue(undefined);
    mockRedis.getPhoneCache.mockResolvedValue({ wabaId: 'w1', accessToken: 'enc' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InboxMediaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: EncryptionService, useValue: mockEncryption },
      ],
    }).compile();
    service = module.get(InboxMediaService);
  });

  /** Meta answers twice: the id resolves to a URL, then the URL to bytes. */
  const happyPath = (): void => {
    mockPrisma.inboundMessage.findFirst.mockResolvedValue(inboundRow());
    mockedAxios.get = jest
      .fn()
      .mockResolvedValueOnce({ data: { url: 'https://lookaside.fb/media/1' } })
      .mockResolvedValueOnce({
        data: Readable.from(['bytes']),
        headers: { 'content-type': 'image/jpeg', 'content-length': '5' },
      });
  };

  it('resolves the media id, then streams the file back', async () => {
    happyPath();

    const media = await service.fetch('org-a', 9);

    expect(media.contentType).toBe('image/jpeg');
    expect(media.contentLength).toBe(5);
    expect(media.stream).toBeInstanceOf(Readable);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      1,
      'https://graph.facebook.com/v21.0/MEDIA1',
      { headers: { Authorization: 'Bearer plain_token' } },
    );
  });

  it('scopes the lookup to an account the organisation holds', async () => {
    happyPath();

    await service.fetch('org-a', 9);

    const { where } = mockPrisma.inboundMessage.findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(where).toMatchObject({
      id: 9,
      waba: { WabaOrganisation: { some: { ssoOrgId: 'org-a' } } },
    });
  });

  it('narrows further to the WABA an API key is scoped to', async () => {
    happyPath();

    await service.fetch('org-a', 9, 'w-scoped');

    const { where } = mockPrisma.inboundMessage.findFirst.mock.calls[0][0] as {
      where: { wabaId?: string };
    };
    expect(where.wabaId).toBe('w-scoped');
  });

  it('refuses a message the caller cannot see', async () => {
    mockPrisma.inboundMessage.findFirst.mockResolvedValue(null);
    await expect(service.fetch('org-b', 9)).rejects.toThrow(NotFoundException);
  });

  it('refuses a message that carries no media', async () => {
    mockPrisma.inboundMessage.findFirst.mockResolvedValue(
      inboundRow({ type: 'text', payload: { body: 'Thanks!' } }),
    );
    await expect(service.fetch('org-a', 9)).rejects.toThrow(/no media/);
  });

  it('reuses a resolved URL rather than asking Meta twice', async () => {
    mockPrisma.inboundMessage.findFirst.mockResolvedValue(inboundRow());
    mockRedis.getMediaUrl.mockResolvedValue('https://lookaside.fb/cached');
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: Readable.from(['bytes']),
      headers: { 'content-type': 'image/jpeg' },
    });

    await service.fetch('org-a', 9);

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://lookaside.fb/cached',
      expect.anything(),
    );
  });

  it('explains media Meta has dropped, rather than failing opaquely', async () => {
    mockPrisma.inboundMessage.findFirst.mockResolvedValue(inboundRow());
    mockedAxios.get = jest.fn().mockRejectedValue({ response: { status: 404 } });

    await expect(service.fetch('org-a', 9)).rejects.toThrow(/no longer available/);
  });

  it('drops a cached URL that has expired since it was stored', async () => {
    mockPrisma.inboundMessage.findFirst.mockResolvedValue(inboundRow());
    mockedAxios.get = jest
      .fn()
      .mockResolvedValueOnce({ data: { url: 'https://lookaside.fb/media/1' } })
      .mockRejectedValueOnce({ response: { status: 403 } });

    await expect(service.fetch('org-a', 9)).rejects.toThrow(/could not be fetched/);
    // So the next view resolves it again instead of retrying a dead link.
    expect(mockRedis.setMediaUrl).toHaveBeenLastCalledWith('MEDIA1', '', 1);
  });

  it('needs a synced number to have a token at all', async () => {
    mockPrisma.inboundMessage.findFirst.mockResolvedValue(inboundRow());
    mockRedis.getPhoneCache.mockResolvedValue(null);

    await expect(service.fetch('org-a', 9)).rejects.toThrow(/phone sync/);
  });

  it('falls back to the type the webhook reported when Meta sends no content type', async () => {
    mockPrisma.inboundMessage.findFirst.mockResolvedValue(inboundRow());
    mockedAxios.get = jest
      .fn()
      .mockResolvedValueOnce({ data: { url: 'https://lookaside.fb/media/1' } })
      .mockResolvedValueOnce({ data: Readable.from(['bytes']), headers: {} });

    const media = await service.fetch('org-a', 9);
    expect(media.contentType).toBe('image/jpeg');
  });

  it('offers the filename a document arrived with', async () => {
    mockPrisma.inboundMessage.findFirst.mockResolvedValue(
      inboundRow({
        type: 'document',
        payload: { id: 'MEDIA1', mime_type: 'application/pdf', filename: 'invoice.pdf' },
      }),
    );
    mockedAxios.get = jest
      .fn()
      .mockResolvedValueOnce({ data: { url: 'https://lookaside.fb/media/1' } })
      .mockResolvedValueOnce({
        data: Readable.from(['bytes']),
        headers: { 'content-type': 'application/pdf' },
      });

    const media = await service.fetch('org-a', 9);
    expect(media.filename).toBe('invoice.pdf');
  });
});
