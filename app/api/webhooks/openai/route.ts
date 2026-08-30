import { loadVoltaConfig } from "@/lib/config";
import { apiError } from "@/lib/http";
import { OpenAiAgentsRuntime } from "@/lib/volta/openai-agents-runtime";
import { getVoiceControlService } from "@/lib/volta/service";

export const runtime = "nodejs";

/**
 * OpenAI notifies here when a SIP call reaches the project. The payload is
 * verified with the project webhook secret, not with any shared dashboard
 * credential, so this route stays outside the basic-auth proxy.
 */
export async function POST(request: Request) {
  try {
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
      console.warn(`Rejected OpenAI webhook: ${reason}`);
      return Response.json({ error: "Invalid OpenAI webhook signature." }, { status: 400 });
    }

    return Response.json(await getVoiceControlService().handleOpenAiWebhook(event));
  } catch (error) {
    return apiError(error);
  }
}
