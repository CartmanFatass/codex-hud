// Constructor-injected, lab-only preparation for one fixed fake executable.
// It grants no capability, writes no state, and starts no processes.
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { snapshotBrief } from '../../packages/hud-mcp/dist/src/core/launch/brief.js';
import { makeSourceId } from '../../packages/hud-mcp/dist/src/core/identity.js';
import { launchProfileDigest } from '../../packages/hud-mcp/dist/src/core/capabilities.js';
import { digest } from '../../packages/hud-mcp/dist/src/core/canonical.js';
import { launchDigest } from '../../packages/hud-mcp/dist/src/core/run/control.js';
import { freezeRetirementPolicy } from '../../packages/hud-mcp/dist/src/core/run/retirement-policy.js';
export function makeLabPiPreparer(root, executable) {
  return async (options)=>{
    const p=options.profile;
    if (p.harness!=='pi' || p.name!=='synthetic-pi' || options.operation!=='spawn' || options.mode!=='headless' ||
      options.role!=='implementer' || options.prompt || options.model || options.effort || options.resumeSessionId || p.host.kind!=='none' || p.host.layout!=='none' ||
      await realpath(p.source.root)!==root || await realpath(options.cwd)!==root ||
      !p.headless?.argv || p.headless.argv.length!==1 || p.headless.argv[0]!==executable || await realpath(executable)!==executable)
      throw Error('unsupported_lab_pi_profile');
    const brief=await snapshotBrief(options.briefPath), sourceId=makeSourceId('pi',root), profileDigest=launchProfileDigest(p);
    const fp=digest({lab:'fixed-synthetic-pi',root,executable});
    const key={harness:'pi',profileDigest,hostKind:'none',layout:'none',mode:'headless',operation:'spawn'};
    return Object.freeze({harness:'pi',sourceRoot:root,sourceId,cwd:root,brief,profileDigest,promptHash:digest(''),role:'implementer',model:'synthetic-model',effort:null,configFingerprint:fp,commandFingerprint:fp,
      capabilityRequest:()=>({executableIdentity:{path:executable,version:'synthetic-lab'},key,sourceId,profileFingerprint:fp}),
      forRun:({runId,hudHome,parent})=>{
        if (hudHome!==root) throw Error('invalid_lab_home');
        const input={runId,mode:'headless',launch:{argv:[executable]},cwd:root,sourceId,profileDigest,stdin:'brief',orphanPolicy:'continue',retire:freezeRetirementPolicy(undefined,'implementer')};
        const bytes=brief.bytes();
        return {input,launchDigest:launchDigest(input),payload:{input,briefBase64:bytes.toString('base64'),env:{HOME:root,HUD_HOME:root,PATH:'/usr/bin:/bin'},...(parent?{parent}:{})},deliveredSha256:createHash('sha256').update(bytes).digest('hex')};
      }
    });
  };
}
