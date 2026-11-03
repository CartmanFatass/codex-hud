import type { ChildProcess } from 'node:child_process';

type Message = { id?: number; point?: string; error?: string; result?: any; [key: string]: unknown };
type Waiter = {
  match: (message: Message) => boolean;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
};

/** Parent-side observation for an owned synthetic helper, including failures before its imports finish. */
export class ProcessClient {
  readonly closed: Promise<void>;
  private serial = 0;
  private stderr = '';
  private failure: Error | null = null;
  private waiters: Waiter[] = [];
  private messages: Message[] = [];
  private failureTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly child: ChildProcess,
    private readonly label: string
  ) {
    child.stderr!.on('data', (chunk) => {
      // Continue draining after the diagnostic cap so a noisy helper cannot block on its pipe.
      this.stderr += String(chunk).slice(0, Math.max(0, 8192 - this.stderr.length));
    });
    child.on('message', (message: Message) => {
      if (this.failure) return;
      if (message.error && message.id === undefined) {
        this.fail(`reported ${message.error}`);
        return;
      }
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
      else this.messages.push(message);
    });
    // close follows stderr drainage, unlike exit/disconnect. Give termination that is already
    // underway a chance to provide its complete import diagnostic; live IPC failures stay bounded.
    child.on('error', (error) => this.ipcFailure(error.message));
    child.on('disconnect', () => this.ipcFailure('IPC disconnected'));
    this.closed = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        clearTimeout(this.failureTimer);
        this.fail(`exited (code ${code}, signal ${signal}) before replying`);
        resolve();
      });
    });
  }

  private fail(reason: string): void {
    this.failure = new Error(`${this.label} ${reason}: ${this.stderr}`);
    this.messages = [];
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
  }

  private ipcFailure(reason: string): void {
    if (this.failure || this.failureTimer) return;
    this.failureTimer = setTimeout(() => this.fail(reason), 50);
  }

  wait(match: (message: Message) => boolean): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure);
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => this.waiters.push({ match, resolve, reject }));
  }

  send(message: Message): void {
    if (this.failure) return;
    try {
      this.child.send(message, (error) => {
        if (error) this.ipcFailure(error.message);
      });
    } catch (error) {
      this.ipcFailure(String(error));
    }
  }

  async call(op: string, fields: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.serial;
    const response = this.wait((message) => message.id === id);
    this.send({ ...fields, id, op });
    const message = await response;
    if (message.error) throw new Error(`${this.label}: ${message.error}`);
    return message.result;
  }

  point(point: string): Promise<Message> {
    return this.wait((message) => message.point === point);
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.closed;
  }
}
