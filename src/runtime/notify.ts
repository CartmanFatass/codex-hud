import { join } from 'node:path';
import { jobCallerPane } from '../roles/job-pane.js';
import { notify, taskDelivery } from '../roles/notify.js';
import type { Job } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { readJsonFile } from '../utils/atomic-fs.js';

export * from '../roles/notify.js';

export async function runNotifyCli() {
  const [home, launchPane, job, message = ''] = process.argv.slice(2);
  process.env.HUD_HOME = home;
  let pane = launchPane;
  if (/^j[0-9a-f]{16}$/.test(job)) {
    try {
      const dir = join(home, 'jobs', job);
      const receipt = readJsonFile(join(dir, jobFiles.job)) as Job;
      // Scouts hand all outcomes to their target. Other children and land repairs still forward questions.
      if (receipt.scout_only === true || receipt.ticket_queue || ((receipt.parent_job || receipt.land_turn) && /^\[.*\] DONE /.test(message))) process.exit(0);
      const owner = jobCallerPane(receipt);
      if (owner && !/[\x00-\x1f\x7f-\x9f]/.test(owner)) pane = owner;
      if (taskDelivery(dir, pane)) process.exit(0);
    } catch { /* No receipt: keep the launch delivery path. */ }
  }
  // pi-roles builds a file-write reply; the HUD main session answers through its MCP.
  const line = message.replace(/ \| reply: write .*$/, ` | reply: hud_respond job=${job} request_id=${message.match(/QUESTION (q\d+):/)?.[1] ?? ''}`);
  const result = await notify(pane, line);
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  process.exitCode = result.status ?? 1;
}
