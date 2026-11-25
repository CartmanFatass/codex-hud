// Old ticket queues fork this path and only recognize the bare 'ready'. Refuse
// before they publish a legacy receipt; they then report their rebuild failure.
const error = 'incompatible-generation';
process.stderr.write(`${error}: incompatible generation; restart the ticket queue before retrying the land.\n`);
process.exitCode = 1;
if (process.connected) process.send(error, () => {});
