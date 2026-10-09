import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { configFromEnv } from "./config.ts";
import { openDb } from "./db.ts";
import { AttributionService } from "./service.ts";

const config = configFromEnv(process.env);
const db = openDb(process.env.DB_PATH ?? "data/attribution.db");
const app = createApp(new AttributionService({ db, clock: systemClock, config }));
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`signup-origin em http://127.0.0.1:${info.port}`);
  const days = config.attribution.windowMs / 86_400_000;
  console.log(`janela: ${days} dias após a primeira abertura`);
});
