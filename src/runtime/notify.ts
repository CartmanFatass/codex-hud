import { join } from 'node:path';
import { jobCallerPane } from '../roles/job-pane.js';
import { noticeResolver } from '../roles/select-send.js';
import { jobNoticeOrigin } from '../workflows/scope.js';
import { notify, taskDelivery } from '../roles/notify.js';
import type { Job } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { readJsonFile } from '../utils/atomic-fs.js';

export * from '../roles/notify.js';

export async function runNotifyCli() {
  const [home, launchPane, job, message = ''] = process.argv.slice(2);
  process.env.HUD_HOME = home;
  let pane = launchPane;
  const question = /^\[[^\]\n]+\] QUESTION (q\d+):/.exec(message);
  if (/^j[0-9a-f]{16}$/.test(job)) {
    try {
      const dir = join(home, 'jobs', job);
      const receipt = readJsonFile(join(dir, jobFiles.job)) as Job;
      // Scouts hand all outcomes to their target. Other children and land repairs still forward questions.
      if (receipt.scout_only === true || receipt.council || receipt.ticket_queue || ((receipt.workflow || receipt.batch_flow) && !question) || ((receipt.parent_job || receipt.land_turn) && /^\[.*\] DONE /.test(message))) process.exit(0);
      const owner = jobCallerPane(receipt);
      if (question) {
        const recipient = await noticeResolver(home)(jobNoticeOrigin(home, receipt));
        if (recipient.kind !== 'pane') return;
        pane = recipient.pane;
      } else if (owner && !/[\x00-\x1f\x7f-\x9f]/.test(owner)) pane = owner;
      if (taskDelivery(dir, pane)) return;
    } catch { if (question) return; }
  } else if (question) return;
  // Translate legacy file-write reply hints into the HUD main session's MCP call.
  const line = message.replace(/ \| reply: write .*$/, ` | reply: hud_respond job=${job} request_id=${question?.[1] ?? ''}`);
  const result = await notify(pane, line);
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  // A refusal leaves the published notice available through the ordinary HUD reads.
  process.exitCode = result.retryPrompt ? 0 : (result.status ?? 1);
}
