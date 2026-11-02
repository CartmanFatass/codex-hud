// Deterministic real process commit in the wait subscription-registration seam.
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
const ledger = await openLedger(process.argv[2]);
try {
  await ledger.transaction((tx) => {
    tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'");
    tx.run(
      "INSERT INTO events(link_id,run_id,kind,payload,at) VALUES('link-a','run-a','run.state','{}',?)",
      Date.now()
    );
  });
} finally {
  await ledger.close();
}
