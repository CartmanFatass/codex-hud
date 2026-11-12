export interface RecapPart {
  goal: string;
  done: string[];
  now: string;
  /** Present only when the session waits on the person. */
  needs?: string;
}

export interface Recap extends RecapPart {
  /** When it was written, in ms. */
  at: number;
}
