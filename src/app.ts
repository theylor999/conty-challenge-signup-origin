import { Hono } from "hono";
import { AppError } from "./errors.ts";
import type { AttributionService } from "./service.ts";
import * as v from "./validate.ts";

export function createApp(service: AttributionService): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  // Admin-style endpoint to create the links marketing and creators share.
  app.post("/links", async (c) => {
    const body = await v.readBody(c.req.raw);
    const { created, link } = service.createLink({
      kind: v.kind(body.kind),
      ref: v.ref(body.ref),
      code: v.optionalId(body.code, "code"),
    });
    return c.json(link, created ? 201 : 200);
  });

  // Public short link: log the click, then send the browser on with the click id.
  app.get("/i/:code", (c) => {
    const target = service.registerClick(c.req.param("code"), c.req.header("user-agent") ?? null);
    c.header("Cache-Control", "no-store");
    return c.redirect(target, 302);
  });

  app.post("/installs/:install_id/first-open", async (c) => {
    const installId = v.id(c.req.param("install_id"), "install_id");
    const body = await v.readBody(c.req.raw, true);
    const result = service.firstOpen(installId, v.optionalInstant(body.opened_at, "opened_at"));
    return c.json(result, result.created ? 201 : 200);
  });

  app.post("/touches", async (c) => {
    const body = await v.readBody(c.req.raw);
    const clickId = v.optionalId(body.click_id, "click_id");
    const result = service.recordTouch({
      installId: v.id(body.install_id, "install_id"),
      clickId,
      // With a click_id the server's record decides kind/ref; they are only checked when sent.
      kind: clickId && body.kind === undefined ? undefined : v.kind(body.kind),
      ref: clickId && body.ref === undefined ? undefined : v.ref(body.ref),
      openedAt: v.optionalInstant(body.opened_at, "opened_at"),
    });
    return c.json(result, result.duplicate ? 200 : 201);
  });

  app.post("/signups", async (c) => {
    const body = await v.readBody(c.req.raw);
    const { created, body: decision } = service.signup({
      userId: v.id(body.user_id, "user_id"),
      installId: v.optionalId(body.install_id, "install_id"),
      signedUpAt: v.optionalInstant(body.signed_up_at, "signed_up_at"),
    });
    return c.json(decision, created ? 201 : 200);
  });

  app.get("/signups/:user_id/attribution", (c) =>
    c.json(service.getAttribution(v.id(c.req.param("user_id"), "user_id"))),
  );

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "Erro interno." } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Rota não existe." } }, 404));

  return app;
}
