/** A data-only response queue: decisions belong to core helpers, never to a fake. */
export class Script<Args extends unknown[], Result> {
  readonly calls: Args[] = [];

  constructor(public responses: (Result | Error)[] = []) {}

  async invoke(...args: Args): Promise<Result> {
    this.calls.push(structuredClone(args));
    if (this.responses.length === 0) throw new Error('fake_response_missing');
    const response = this.responses.shift()!;
    if (response instanceof Error) throw response;
    return structuredClone(response);
  }
}
