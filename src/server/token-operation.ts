/** Marks failures that happened before an external provider write was attempted. */
export class TokenOperationSafeFailure extends Error {
  constructor(readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : 'The operation could not be completed.');
    this.name = 'TokenOperationSafeFailure';
  }
}
