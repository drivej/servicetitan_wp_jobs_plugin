export class ServiceTitanRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ServiceTitanRequestError';
  }
}
