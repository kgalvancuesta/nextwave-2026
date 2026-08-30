import { loadVoltaConfig } from "@/lib/config";
import { apiError } from "@/lib/http";
import { OpenAiAgentsRuntime } from "@/lib/volta/openai-agents-runtime";
import { getVoiceControlService } from "@/lib/volta/service";
import { voiceError, voiceLog } from "@/lib/voice-log";

export const runtime = "nodejs";

/**
 * OpenAI notifies here when a SIP call reaches the project. The payload is
 * verified with the project webhook secret, not with any shared dashboard
 * credential, so this route stays outside the basic-auth proxy.
 */
export async function POST(request: Request) {
  try {
    const requestId = request.headers.get("x-request-id") || request.headers.get("webhook-id");
    voiceLog("info", "openai.webhook_received", {
      requestId,
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
    });
    const config = loadVoltaConfig();
    const rawBody = await request.text();
    const headers = Object.fromEntries(request.headers.entries());
    const verifier = new OpenAiAgentsRuntime({
      apiKey: config.openAiApiKey,
      webhookSecret: config.openAiWebhookSecret,
      model: config.realtimeModel,
      transcriptionModel: config.transcriptionModel,
      voice: config.voice,
    });

    let event: unknown;
    try {
      event = await verifier.verifyWebhook(rawBody, headers);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown signature verification error";
      voiceLog("warn", "openai.webhook_rejected", { requestId, reason });
      return Response.json({ error: "Invalid OpenAI webhook signature." }, { status: 400 });
    }
    const verified = event as { type?: unknown; data?: { call_id?: unknown } };
    voiceLog("info", "openai.webhook_verified", {
      requestId,
      type: verified.type,
      realtimeCallId: verified.data?.call_id,
    });
    const result = await getVoiceControlService().handleOpenAiWebhook(event);
    voiceLog("info", "openai.webhook_handled", { requestId, result });
    return Response.json(result);
  } catch (error) {
    voiceLog("error", "openai.webhook_failed", { error: voiceError(error) });
    return apiError(error);
  }
}
