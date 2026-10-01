export class OpenAIRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'OpenAIRequestError';
  }
}
