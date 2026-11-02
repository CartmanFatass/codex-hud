/** Small young generation without an old-space cap, JIT change or worker-pool change.
 * Apply only to HUD processes; never pass these flags through a harness environment.
 */
export const RUN_NODE_FLAGS = ['--max-semi-space-size=1'] as const;
