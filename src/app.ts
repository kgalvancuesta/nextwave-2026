import Fastify from "fastify";
import { z, ZodError } from "zod";
import { HttpOutboundTelephonyGateway, HttpRecapGateway } from "./adapters/http-gateways.js";
import { OpenAiRealtimeGateway } from "./adapters/openai-realtime.js";
import { SqliteStateStore } from "./adapters/sqlite-store.js";
import { VoiceControlService } from "./application/voice-control-service.js";
import type { AppConfig } from "./config.js";

const outboundCallSchema = z.object({
  to: z.string().min(3),
  counterparty: z.string().min(1).optional(),
});

const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inject_context"), value: z.string().min(1) }),
  z.object({ action: z.literal("transfer"), value: z.string().min(1).optional() }),
  z.object({ action: z.literal("hangup") }),
]);

export function buildApp(config: AppConfig) {
  const app = Fastify({ logger: true });
  const store = new SqliteStateStore(config.DATABASE_PATH);
  const realtime = new OpenAiRealtimeGateway({
    apiKey: config.OPENAI_API_KEY,
    webhookSecret: config.OPENAI_WEBHOOK_SECRET,
    model: config.OPENAI_REALTIME_MODEL,
    voice: config.OPENAI_VOICE,
  });
  const service = new VoiceControlService(
    store,
    realtime,
    new HttpOutboundTelephonyGateway(config.TELEPHONY_OUTBOUND_URL, config.TELEPHONY_OUTBOUND_TOKEN),
    new HttpRecapGateway(config.RECAP_DELIVERY_URL, config.RECAP_DELIVERY_TOKEN),
    { sipUri: config.OPENAI_SIP_URI, humanEscalationUri: config.HUMAN_ESCALATION_URI },
  );

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/") || request.url === "/v1/webhooks/openai") return;
    if (!config.CONTROL_API_TOKEN) return;
    if (request.headers.authorization !== `Bearer ${config.CONTROL_API_TOKEN}`) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(400).send({ error: "invalid_request", issues: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      void reply.code(404).send({ error: message });
      return;
    }
    if (/not configured|no active|not owned/i.test(message)) {
      void reply.code(503).send({ error: message });
      return;
    }
    app.log.error(error);
    void reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/operations", async (request, reply) => {
    const operation = service.createOperation(parseJsonBody(request.body));
    return reply.code(201).send(operation);
  });

  app.get<{ Params: { id: string } }>("/v1/operations/:id", async (request, reply) => {
    const snapshot = service.getOperationSnapshot(request.params.id);
    if (!snapshot) return reply.code(404).send({ error: "operation_not_found" });
    return snapshot;
  });

  app.post<{ Params: { id: string } }>("/v1/operations/:id/calls", async (request, reply) => {
    const body = outboundCallSchema.parse(parseJsonBody(request.body));
    const call = await service.startOutboundCall(request.params.id, body.to, body.counterparty);
    return reply.code(202).send(call);
  });

  app.post("/v1/webhooks/openai", async (request, reply) => {
    const rawBody = rawBodyString(request.body);
    let event: unknown;
    try {
      event = await realtime.verifyWebhook(rawBody, request.headers);
    } catch {
      return reply.code(400).send({ error: "invalid_webhook" });
    }
    const result = await service.handleOpenAiWebhook(event);
    return reply.code(200).send(result);
  });

  app.post<{ Params: { id: string } }>("/v1/calls/:id/control", async (request) => {
    const body = controlSchema.parse(parseJsonBody(request.body));
    await service.controlCall(request.params.id, body.action, "value" in body ? body.value : undefined);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/calls/:id/complete", async (request) => ({
    outcomes: await service.completeCall(request.params.id),
  }));

  return app;
}

function parseJsonBody(body: unknown): unknown {
  return JSON.parse(rawBodyString(body)) as unknown;
}

function rawBodyString(body: unknown): string {
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  return body;
}
