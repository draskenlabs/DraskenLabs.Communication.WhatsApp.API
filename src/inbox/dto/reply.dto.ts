import { OmitType } from '@nestjs/swagger';
import { SendMessageDto } from 'src/messaging/dto/send-message.dto';

/**
 * A reply in an existing thread: a send, minus the routing.
 *
 * Derived from `SendMessageDto` rather than written out again. Every message
 * type the API can send, it can send as a reply, and a copied list of fields
 * would be a second thing to remember whenever one is added — the kind of
 * drift that ends with the inbox quietly unable to send a type the rest of the
 * product supports.
 *
 * What is dropped is what a thread already knows. `to` is the customer whose
 * conversation this is and `phoneNumberId` is the number it is held on;
 * accepting either would let a reply be posted into one thread and delivered
 * to someone else.
 *
 * `OmitType` from `@nestjs/swagger` carries the class-validator metadata
 * across, so each field keeps the rules it has on a send — including the
 * conditional ones, like a template send requiring a template name.
 */
export class SendReplyDto extends OmitType(SendMessageDto, [
  'to',
  'phoneNumberId',
] as const) {}
