// Probe wrapper: no static imports before the first JS timestamp. The /proc
// hook-command start covers shell and Node initialization before this point.
const jsEntry = Number(process.hrtime.bigint()) / 1e6;
const phases = { jsEntry };
try {
  const { runHook } = await import('../../packages/hud-mcp/dist/packages/hud-mcp/src/hook/command.js');
  phases.modulesLoaded = Number(process.hrtime.bigint()) / 1e6;
  const record = await runHook(process.argv[2], (phase, monoMs) => {
    phases[phase] = monoMs;
  });
  const { appendFileSync } = await import('node:fs');
  if (!process.env.HUD_B1B_HOOK_TIMINGS?.startsWith('/')) throw new Error('Run-owned timing path required');
  appendFileSync(
    process.env.HUD_B1B_HOOK_TIMINGS,
    JSON.stringify({
      toolUseId: record.toolUseId,
      hookStartMonoMs: record.hookStartMonoMs,
      hookStartUncertaintyMs: record.hookStartUncertaintyMs,
      phases,
    }) + '\n',
    { mode: 0o600 }
  );
} catch {
  process.stderr.write('HUD timing probe evidence unavailable\n');
  process.exitCode = 1;
}
