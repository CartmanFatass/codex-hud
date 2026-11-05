// Coalesce paints and prevent an asynchronous frame from writing after stop.
import { setTimeout as delay } from 'node:timers/promises';
export function createPaintGate(build,write,isStopped) {
  let active=null,closed=false;
  function paint() {
    if(closed||isStopped())return Promise.resolve();
    if(active)return active;
    const task=(async()=>{const text=await build();if(!closed&&!isStopped())write(text);})();
    active=task.finally(()=>{active=null;});
    return active;
  }
  return Object.freeze({paint,stop(){closed=true;},async drain(ms=2000){if(!active)return true;return Promise.race([active.then(()=>true,()=>true),delay(ms).then(()=>false)]);}});
}
