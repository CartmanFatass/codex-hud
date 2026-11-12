export interface PiContext {
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionDir(): string;
  };
}
