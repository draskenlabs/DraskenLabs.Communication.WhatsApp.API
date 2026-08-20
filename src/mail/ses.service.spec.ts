import { ConfigService } from '@nestjs/config';
import { SesService } from './ses.service';

/**
 * The raw path only — the SES call itself is exercised through MailService,
 * which stubs this class. What is worth testing here is the MIME: it is
 * assembled by hand, it only runs for messages carrying an invoice, and a
 * boundary in the wrong place is a mail that arrives as an unreadable wall of
 * base64 rather than one that fails loudly.
 */
function service(settings: Record<string, string> = {}): SesService {
  const config = {
    get: (key: string) => settings[key],
  } as unknown as ConfigService;
  const ses = new SesService(config);
  ses.onModuleInit();
  return ses;
}

const MESSAGE = {
  to: 'ada@example.com',
  subject: 'Invoice INV-WAC-2627-0001',
  html: '<p>Here is your invoice.</p>',
  text: 'Here is your invoice.',
  attachments: [
    {
      filename: 'INV-WAC-2627-0001.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 pretend'),
    },
  ],
};

const CONFIGURED = {
  AWS_REGION: 'ap-south-1',
  SES_FROM_ADDRESS: 'no-reply@draskenlabs.com',
  SES_FROM_NAME: 'WhatsApp Console',
  SES_REPLY_TO: 'support@draskenlabs.com',
};

describe('SesService.raw', () => {
  it('addresses the message and declares the multipart it is', () => {
    const mime = service(CONFIGURED).raw(MESSAGE).toString('utf8');

    expect(mime).toContain('From: WhatsApp Console <no-reply@draskenlabs.com>');
    expect(mime).toContain('To: ada@example.com');
    expect(mime).toContain('Reply-To: support@draskenlabs.com');
    expect(mime).toContain('Subject: Invoice INV-WAC-2627-0001');
    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="mixed_/);
  });

  it('separates every header and boundary with CRLF, as SMTP requires', () => {
    const mime = service(CONFIGURED).raw(MESSAGE).toString('utf8');

    expect(mime).toContain('\r\n');
    // A bare newline anywhere would end the headers early on a strict server.
    expect(mime.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('carries both bodies in an alternative part, base64 encoded', () => {
    const mime = service(CONFIGURED).raw(MESSAGE).toString('utf8');

    expect(mime).toMatch(
      /Content-Type: multipart\/alternative; boundary="alt_/,
    );
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
    expect(mime).toContain(
      Buffer.from(MESSAGE.text, 'utf8').toString('base64'),
    );
    expect(mime).toContain(
      Buffer.from(MESSAGE.html, 'utf8').toString('base64'),
    );
  });

  it('attaches the invoice under its own name', () => {
    const mime = service(CONFIGURED).raw(MESSAGE).toString('utf8');

    expect(mime).toContain(
      'Content-Type: application/pdf; name="INV-WAC-2627-0001.pdf"',
    );
    expect(mime).toContain(
      'Content-Disposition: attachment; filename="INV-WAC-2627-0001.pdf"',
    );
    expect(mime).toContain(MESSAGE.attachments[0].content.toString('base64'));
  });

  it('closes every part it opened', () => {
    const mime = service(CONFIGURED).raw(MESSAGE).toString('utf8');

    const mixed = /boundary="(mixed_[^"]+)"/.exec(mime)?.[1] as string;
    const alternative = /boundary="(alt_[^"]+)"/.exec(mime)?.[1] as string;

    // Two openings and a close for mixed (body, attachment, terminator), and
    // the alternative closed before the attachment starts. An unterminated
    // boundary is a message a client renders as raw base64.
    expect(mime.split(`--${mixed}`).length - 1).toBe(3);
    expect(mime).toContain(`--${mixed}--`);
    expect(mime).toContain(`--${alternative}--`);
    expect(mime.trimEnd().endsWith(`--${mixed}--`)).toBe(true);
  });

  it('wraps base64 at 76 characters', () => {
    const long = {
      ...MESSAGE,
      attachments: [
        {
          ...MESSAGE.attachments[0],
          content: Buffer.alloc(2048, 0x41),
        },
      ],
    };
    const mime = service(CONFIGURED).raw(long).toString('utf8');

    const overlong = mime
      .split('\r\n')
      .filter((line) => /^[A-Za-z0-9+/=]+$/.test(line) && line.length > 76);
    expect(overlong).toHaveLength(0);
  });

  it('encodes a subject that is not plain ASCII', () => {
    const mime = service(CONFIGURED)
      .raw({ ...MESSAGE, subject: 'Facture — Café Ltd' })
      .toString('utf8');

    expect(mime).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Facture — Café Ltd', 'utf8').toString('base64')}?=`,
    );
  });

  it('adds the unsubscribe headers only when there is a link', () => {
    const withLink = service(CONFIGURED)
      .raw({ ...MESSAGE, unsubscribeUrl: 'https://console/unsubscribe?u=1' })
      .toString('utf8');
    const without = service(CONFIGURED).raw(MESSAGE).toString('utf8');

    expect(withLink).toContain(
      'List-Unsubscribe: <https://console/unsubscribe?u=1>',
    );
    expect(without).not.toContain('List-Unsubscribe');
  });

  it('strips a filename that would break out of the header', () => {
    const mime = service(CONFIGURED)
      .raw({
        ...MESSAGE,
        attachments: [
          {
            ...MESSAGE.attachments[0],
            filename: 'in"voice\r\nBcc: mallory@example.com.pdf',
          },
        ],
      })
      .toString('utf8');

    // The name is ours — `${number}.pdf` — so this is depth rather than a
    // live threat. What matters is that nothing became a header of its own:
    // the injected text stays inside the quoted filename, on one line.
    expect(mime.split('\r\n').some((line) => line.startsWith('Bcc:'))).toBe(
      false,
    );
    expect(mime).toContain('filename="invoiceBcc: mallory@example.com.pdf"');
  });
});

describe('SesService', () => {
  it('stays disabled, and sends nothing, without a region and a From address', async () => {
    const ses = service();

    expect(ses.enabled).toBe(false);
    await expect(ses.send(MESSAGE)).resolves.toEqual({
      ok: false,
      error: 'mail disabled',
    });
  });
});
