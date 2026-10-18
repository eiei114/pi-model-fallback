import { updateState, upsertStateEntry } from "../../lib/state.ts";

const [path, prefix] = process.argv.slice(2);
process.send?.("ready");
process.once("message", async () => {
  try {
    for (let index = 0; index < 4; index++) {
      const now = Date.now();
      await updateState(path, state => upsertStateEntry(state, {
        source: { provider: "worker", model: `${prefix}-${index}` },
        fallback: { provider: "worker", model: "backup" },
        status: 503, createdAt: new Date(now).toISOString(), until: new Date(now + 60000).toISOString(),
      }));
    }
    process.disconnect();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    process.disconnect();
  }
});
