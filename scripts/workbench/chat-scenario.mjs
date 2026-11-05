import { createChatWorld } from './chat-world.mjs';
const world = await createChatWorld();
try {
  const events = [];
  world.chat.subscribe((event) => {
    if (event.type === 'text') events.push(event.text);
  });
  await world.chat.send('hello from the owner');
  const end = Date.now() + 5000;
  while (!events.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  if (events.join('') !== 'SIMULATED reply: hello from the owner') throw Error('synthetic_reply_missing');
  const snapshot = await world.view();
  console.log(
    JSON.stringify({
      simulated: true,
      runId: world.piRun,
      selection: world.selection,
      ownedRuns: world.ownedRuns,
      dispatches: world.dispatchCount(),
      staleRejected: world.staleRejected,
      reply: events.join(''),
      ledgerRead: !!snapshot,
    })
  );
} finally {
  await world.close();
}
