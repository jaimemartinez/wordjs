// Fixture for plugin-isolate-send-classify.test.ts: a child forked with `serialization:'advanced'` that
// reports readiness and then stays alive with an open IPC channel, so the parent can prove that
// `child.send(<too-deep object>)` throws synchronously while `child.connected` remains true.
process.on('message', () => { /* keep the channel open; nothing to answer */ });
process.send({ ready: true });
setTimeout(() => process.exit(0), 20000).unref();
