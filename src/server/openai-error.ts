export class OpenAIRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'OpenAIRequestError';
  }
}

/** A literal seed fallback is never publishable project copy. */
export class InsufficientJobCopyError extends OpenAIRequestError {
  constructor() { super('try your best', 422); this.name = 'InsufficientJobCopyError'; }
}
