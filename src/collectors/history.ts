/**
 * A bounded series of samples, for the panel's trend display.
 *
 * History starts when the panel opens and lives in memory only. That is a
 * deliberate limit: a trend line that claims to cover the whole session would
 * have to survive restarts and merge across processes, and the panel would be
 * asserting more than it knows. The view states the window it actually covers.
 */

export interface Sample {
  at: number;
  value: number;
}

export class SampleHistory {
  private samples: Sample[] = [];

  constructor(
    private readonly capacity: number = 120,
    private readonly minIntervalMs: number = 1000
  ) {}

  push(value: number, at: number = Date.now()): void {
    const last = this.samples[this.samples.length - 1];
    if (last && at - last.at < this.minIntervalMs) {
      // Repaints run faster than collection; do not stack duplicate samples.
      last.value = value;
      return;
    }
    this.samples.push({ at, value });
    if (this.samples.length > this.capacity) {
      this.samples.splice(0, this.samples.length - this.capacity);
    }
  }

  values(): number[] {
    return this.samples.map((sample) => sample.value);
  }

  /** Milliseconds between the oldest and newest sample, or null if too short. */
  spanMs(): number | null {
    if (this.samples.length < 2) {
      return null;
    }
    return this.samples[this.samples.length - 1].at - this.samples[0].at;
  }

  get size(): number {
    return this.samples.length;
  }
}
