import { serve } from "@hono/node-server";
import { cfg } from "./config.js";
import { ensureRegistryMigrated, createRegistryApp, startRegistryPruneLoop } from "./routes.js";

await ensureRegistryMigrated();

const app  = createRegistryApp({ basePath: cfg.basePath() });
const stop = startRegistryPruneLoop();
const port = cfg.port();

serve(
  { fetch: app.fetch, port, hostname: "0.0.0.0" },
  () => console.log(`MatchClaw registry listening on :${port}`),
);

// Graceful shutdown
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { stop(); process.exit(0); });
}
