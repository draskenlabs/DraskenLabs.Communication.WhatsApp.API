import { OrgDirectoryService } from './org-directory.service';

/**
 * Stand-in for the organisation name lookup.
 *
 * Silent by default — `null` is the honest answer for a test that has told it
 * nothing, and it keeps the "Organisation" line out of asserted facts tables
 * unless a test asks for it.
 */
export function orgDirectoryDouble(): jest.Mocked<
  Pick<OrgDirectoryService, 'name' | 'soleOrgFor' | 'remember'>
> {
  return {
    name: jest.fn().mockResolvedValue(null),
    soleOrgFor: jest.fn().mockResolvedValue(null),
    remember: jest.fn().mockResolvedValue(undefined),
  } as never;
}
