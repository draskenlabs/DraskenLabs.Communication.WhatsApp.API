import { ConversationWriterService } from './conversation-writer.service';

/**
 * Stand-in for the conversation write path.
 *
 * The webhook handler and the send path both keep the inbox current as a side
 * effect of their real work. Neither is testing the summary, and neither
 * should fail to compile a test module because of it.
 *
 * Both methods resolve, always — that is also true of the real service, which
 * swallows its own failures rather than letting a derived summary take down a
 * message that has already been stored or already reached Meta.
 */
export function conversationWriterDouble(): jest.Mocked<
  Pick<ConversationWriterService, 'recordInbound' | 'recordOutbound'>
> {
  return {
    recordInbound: jest.fn().mockResolvedValue(undefined),
    recordOutbound: jest.fn().mockResolvedValue(undefined),
  } as never;
}
