// Lab-only admission state for one sequential private reporter channel.
// Shutdown rejects future admissions; it cannot roll back an admitted write.
export function createLabPiChannelState() {
  let open=true, epoch=null, sequence=0, identity=null;
  return Object.freeze({
    admit(frame) {
      if (!open) throw Error('pi_channel_closed');
      if (!frame || typeof frame!=='object' || Array.isArray(frame) || !Number.isSafeInteger(frame.seq) || frame.seq!==sequence+1 ||
          !['delegate_whoami','delegate_report'].includes(frame.tool) || !frame.snapshot || frame.snapshot.toolName!==frame.tool ||
          typeof frame.snapshot.epoch!=='string' || !frame.snapshot.epoch) throw Error('invalid_pi_channel_request');
      if (epoch===null) epoch=frame.snapshot.epoch;
      if (epoch!==frame.snapshot.epoch) { open=false; throw Error('stale_pi_extension_epoch'); }
      sequence=frame.seq;
    },
    pin(snapshot) {
      if (!open || snapshot.epoch!==epoch) throw Error('stale_pi_extension_epoch');
      const current=JSON.stringify([snapshot.sessionId,snapshot.sessionFile,snapshot.sessionDir]);
      if (identity!==null && identity!==current) { open=false; throw Error('pi_session_retarget_requires_new_epoch'); }
      identity=current;
    },
    shutdown() { open=false; },
  });
}
