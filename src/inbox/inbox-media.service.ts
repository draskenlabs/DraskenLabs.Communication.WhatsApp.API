import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { Readable } from 'stream';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { metaErrorMessage } from 'src/common/utils/meta-error';

/** What a viewer needs to render the file, and the file. */
export interface MediaStream {
  stream: Readable;
  contentType: string;
  contentLength?: number;
  filename?: string;
}

/**
 * Inbound media, fetched back from Meta on the viewer's behalf.
 *
 * A reply that carries a photo does not carry the photo. What arrives on the
 * webhook is a media id, and turning that into bytes takes the account's
 * access token and two calls — so a browser cannot do it, and putting the
 * token where a browser could would be handing out the ability to send as the
 * business.
 *
 * Addressed by inbound message rather than by media id. The id on its own says
 * nothing about who may see it; the message says which account it arrived on,
 * and that is what the caller's organisation is checked against.
 */
@Injectable()
export class InboxMediaService {
  private readonly logger = new Logger(InboxMediaService.name);
  private readonly metaApiVersion = 'v21.0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
  ) {}

  async fetch(
    ssoOrgId: string,
    inboundMessageId: number,
    scopedWabaId?: string,
  ): Promise<MediaStream> {
    const message = await this.prisma.inboundMessage.findFirst({
      where: {
        id: inboundMessageId,
        // The organisation must hold the account the reply arrived on. Written
        // as a membership check rather than a column comparison because an
        // account can be held by several organisations.
        waba: { WabaOrganisation: { some: { ssoOrgId } } },
        ...(scopedWabaId ? { wabaId: scopedWabaId } : {}),
      },
    });
    if (!message) throw new NotFoundException('Message not found');

    const payload = (message.payload ?? {}) as {
      id?: unknown;
      mime_type?: unknown;
      filename?: unknown;
    };
    const mediaId = payload.id;
    if (typeof mediaId !== 'string' || !mediaId) {
      throw new NotFoundException('This message carries no media');
    }

    const token = await this.tokenFor(message.phoneNumberId);
    const url = await this.resolveUrl(mediaId, token);

    try {
      const download = await axios.get<Readable>(url, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'stream',
      });

      return {
        stream: download.data,
        // Meta's own content type on the download, falling back to what the
        // webhook said the message was.
        contentType:
          (download.headers['content-type'] as string | undefined) ??
          (typeof payload.mime_type === 'string'
            ? payload.mime_type
            : 'application/octet-stream'),
        ...(download.headers['content-length']
          ? { contentLength: Number(download.headers['content-length']) }
          : {}),
        ...(typeof payload.filename === 'string'
          ? { filename: payload.filename }
          : {}),
      };
    } catch (err: unknown) {
      // A URL that has expired between resolving and downloading is the one
      // failure worth not caching, so the next view resolves it again.
      await this.redis.setMediaUrl(mediaId, '', 1);
      this.logger.warn(
        `Media download failed for ${mediaId}: ${metaErrorMessage(err) ?? String(err)}`,
      );
      throw new NotFoundException('Media could not be fetched from WhatsApp');
    }
  }

  /**
   * The media id's download URL.
   *
   * Cached briefly: a thread being scrolled asks for every image on screen,
   * and the resolve step is a round trip to Meta that returns the same answer
   * each time until the URL expires.
   */
  private async resolveUrl(mediaId: string, token: string): Promise<string> {
    const cached = await this.redis.getMediaUrl(mediaId);
    if (cached) return cached;

    try {
      const resolved = await axios.get<{ url?: string }>(
        `https://graph.facebook.com/${this.metaApiVersion}/${mediaId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const url = resolved.data?.url;
      if (!url)
        throw new NotFoundException(
          'WhatsApp returned no download URL for this media',
        );

      await this.redis.setMediaUrl(mediaId, url);
      return url;
    } catch (err: unknown) {
      if (err instanceof NotFoundException) throw err;
      this.logger.warn(
        `Could not resolve media ${mediaId}: ${metaErrorMessage(err) ?? String(err)}`,
      );
      // Meta drops media after 30 days, which is well inside the history some
      // plans keep — an old thread with an unfetchable photo is expected, not
      // a fault.
      throw new NotFoundException('Media is no longer available from WhatsApp');
    }
  }

  /** The account token for the number a reply arrived on. */
  private async tokenFor(phoneNumberId: string): Promise<string> {
    const cache = await this.redis.getPhoneCache(phoneNumberId);
    if (!cache) {
      throw new NotFoundException(
        `Phone number ${phoneNumberId} not found. Run a phone sync first.`,
      );
    }
    return this.encryption.decrypt(cache.accessToken);
  }
}
