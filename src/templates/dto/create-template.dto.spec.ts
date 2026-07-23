import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { CreateTemplateDto } from './create-template.dto';

/**
 * Regression: the global ValidationPipe transforms with
 * `whitelist: true` + `enableImplicitConversion: true`. Previously `buttons`
 * was an untyped `Record<string, unknown>[]` and the AUTHENTICATION BODY/FOOTER
 * fields were undecorated, so transformation stripped them to empty objects and
 * Meta rejected the template ("components[..]['buttons'][0]['type'] is required").
 * These tests guard the typed DTO that preserves the fields.
 */
describe('CreateTemplateDto transform (ValidationPipe parity)', () => {
  const transform = (payload: unknown) =>
    plainToInstance(CreateTemplateDto, payload, {
      enableImplicitConversion: true,
    }) as any;

  it('preserves the OTP button type and otp_type', () => {
    const dto = transform({
      name: 'otp_login',
      category: 'AUTHENTICATION',
      language: 'en_US',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 10 },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
      ],
    });

    expect(dto.components[0]).toMatchObject({ type: 'BODY', add_security_recommendation: true });
    expect(dto.components[1]).toMatchObject({ type: 'FOOTER', code_expiration_minutes: 10 });
    expect(dto.components[2].buttons[0]).toEqual({ type: 'OTP', otp_type: 'COPY_CODE' });
  });

  it('preserves call-to-action button fields', () => {
    const dto = transform({
      name: 'order_shipped',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        { type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Aanya']] } },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'URL', text: 'Track', url: 'https://x.com/{{1}}', example: ['48210'] },
            { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+15550051310' },
            { type: 'QUICK_REPLY', text: 'Stop' },
          ],
        },
      ],
    });

    expect(dto.components[1].buttons).toEqual([
      { type: 'URL', text: 'Track', url: 'https://x.com/{{1}}', example: ['48210'] },
      { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+15550051310' },
      { type: 'QUICK_REPLY', text: 'Stop' },
    ]);
  });

  it('preserves one-tap OTP app fields', () => {
    const dto = transform({
      name: 'otp_autofill',
      category: 'AUTHENTICATION',
      language: 'en_US',
      components: [
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'OTP',
              otp_type: 'ONE_TAP',
              autofill_text: 'Autofill',
              package_name: 'com.example.app',
              signature_hash: 'K8a/AINcGX7',
            },
          ],
        },
      ],
    });

    expect(dto.components[0].buttons[0]).toEqual({
      type: 'OTP',
      otp_type: 'ONE_TAP',
      autofill_text: 'Autofill',
      package_name: 'com.example.app',
      signature_hash: 'K8a/AINcGX7',
    });
  });
});
