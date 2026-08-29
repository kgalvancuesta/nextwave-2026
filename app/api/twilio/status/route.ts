import { handleStatusCallback } from "@/lib/call-service";
import { loadTelephonyConfig } from "@/lib/config";
import { apiError } from "@/lib/http";
import { getRepository } from "@/lib/repository";
import { parseTwilioForm, validateTwilioWebhook } from "@/lib/twilio-webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = loadTelephonyConfig();
    const params = await parseTwilioForm(request);
    if (!validateTwilioWebhook(request, params, config)) {
      console.warn("Rejected invalid Twilio webhook signature", { path: new URL(request.url).pathname });
      return Response.json({ error: "Invalid Twilio signature." }, { status: 403 });
    }
    const internalCallId = new URL(request.url).searchParams.get("callId");
    if (internalCallId && params.CallSid) getRepository().attachTwilioSidIfMissing(internalCallId, params.CallSid);
    handleStatusCallback({ params, repository: getRepository() });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}
