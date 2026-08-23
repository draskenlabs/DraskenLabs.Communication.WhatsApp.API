/**
 * One spelling of a phone number, so one customer is one conversation.
 *
 * The same person reaches this system written three ways: Meta reports the
 * sender of a reply as bare digits, an API caller sends `to` in whatever form
 * their own records hold it (`+91 98220 10210`, `0091…`, `919822010210`), and
 * the console's own composer formats it for display. Comparing those as
 * strings makes a new thread per spelling.
 *
 * Digits only, and no attempt at anything cleverer. Real E.164 normalisation
 * needs to know the caller's country to resolve a national number, which
 * nothing here does — and Meta only ever addresses full international numbers,
 * so stripping punctuation is enough and never wrong in the way a guessed
 * country code would be.
 */
export function normalisePhone(value: string): string {
  return (value ?? '').replace(/\D/g, '');
}
