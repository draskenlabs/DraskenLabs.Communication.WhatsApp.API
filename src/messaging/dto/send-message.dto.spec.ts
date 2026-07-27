import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { SendMessageDto } from './send-message.dto';

/**
 * Regression: the global ValidationPipe transforms with
 * `whitelist: true` + `enableImplicitConversion: true`. When `templateComponents`
 * was an untyped `any[]`, transformation stripped each component to an empty
 * object and Meta rejected the send with
 * "template.components.N ... missing: 'type'". These tests guard the typed
 * nested DTOs that preserve the fields.
 */
describe('SendMessageDto transform (ValidationPipe parity)', () => {
  const transform = (payload: unknown) =>
    plainToInstance(SendMessageDto, payload, {
      enableImplicitConversion: true,
    }) as any;

  it('preserves template component type, parameters and text', () => {
    const dto = transform({
      phoneNumberId: 'p1',
      to: '919958906035',
      type: 'template',
      templateName: 'seasonal_promotion',
      templateLanguage: 'en',
      templateComponents: [
        { type: 'header', parameters: [{ type: 'text', text: 'Summer Sale' }] },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: '31 July' },
            { type: 'text', text: '25%' },
          ],
        },
      ],
    });

    expect(dto.templateComponents).toHaveLength(2);
    expect(dto.templateComponents[0].type).toBe('header');
    expect(dto.templateComponents[0].parameters[0]).toEqual({
      type: 'text',
      text: 'Summer Sale',
    });
    expect(dto.templateComponents[1].type).toBe('body');
    expect(dto.templateComponents[1].parameters).toHaveLength(2);
  });

  it('preserves a URL button component and a media header link', () => {
    const dto = transform({
      phoneNumberId: 'p1',
      to: '919958906035',
      type: 'template',
      templateName: 't',
      templateLanguage: 'en',
      templateComponents: [
        { type: 'header', parameters: [{ type: 'image', image: { link: 'https://x/i.jpg' } }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'sale' }] },
      ],
    });

    expect(dto.templateComponents[0].parameters[0].image).toEqual({ link: 'https://x/i.jpg' });
    expect(dto.templateComponents[1]).toMatchObject({
      type: 'button',
      sub_type: 'url',
      index: '0',
    });
  });
});
