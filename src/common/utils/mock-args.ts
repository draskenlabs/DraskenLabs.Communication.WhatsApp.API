/**
 * The first argument a mocked call was made with, typed.
 *
 * `mock.calls[0][0]` is `any`, and reaching into it is how a spec quietly stops
 * checking anything: a renamed column goes on passing because `any.oldName` is
 * simply `undefined`. Naming the shape here puts that back under the compiler.
 */
export const firstArg = <T>(fn: jest.Mock): T =>
  (fn.mock.calls as unknown as T[][])[0][0];
