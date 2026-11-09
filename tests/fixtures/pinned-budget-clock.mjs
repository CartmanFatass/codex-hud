/** Content/composition checks only: do not turn scheduler pauses into read-budget failures.
 * The real bins, filesystem readers and publishers still run. Timers and Date.now
 * (evidence freshness) are unchanged. Deadline/degradation tests must not load this.
 */
Object.defineProperty(performance, 'now', { value: () => 0, configurable: true });
