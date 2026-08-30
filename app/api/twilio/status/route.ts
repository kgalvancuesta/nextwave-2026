import { handleStatusCallback } from "@/lib/call-service";
import { loadTelephonyConfig } from "@/lib/config";
import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";
import { getRepository } from "@/lib/repository";
import { parseTwilioForm, validateTwilioWebhook } from "@/lib/twilio-webhook";
import { voiceError, voiceLog } from "@/lib/voice-log";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = loadTelephonyConfig();
    const params = await parseTwilioForm(request);
    const internalCallId = new URL(request.url).searchParams.get("callId");
    voiceLog("info", "twilio.status_received", {
      callId: internalCallId,
      twilioCallSid: params.CallSid,
      status: params.CallStatus,
      sequenceNumber: params.SequenceNumber,
      durationSeconds: params.CallDuration,
      errorCode: params.ErrorCode,
    });
    if (!validateTwilioWebhook(request, params, config)) {
      voiceLog("warn", "twilio.status_rejected", { callId: internalCallId, twilioCallSid: params.CallSid });
      return Response.json({ error: "Invalid Twilio signature." }, { status: 403 });
    }
    if (internalCallId && params.CallSid) getRepository().attachTwilioSidIfMissing(internalCallId, params.CallSid);
    const call = handleStatusCallback({ params, repository: getRepository() });
    voiceLog("info", "twilio.status_applied", {
      callId: call.id,
      twilioCallSid: call.twilioCallSid,
      status: call.status,
      answeredAt: call.answeredAt,
      completedAt: call.completedAt,
      durationSeconds: call.durationSeconds,
    });
    if (call.marketId) getOrderMarketService().reevaluateMarket(call.marketId);
    return new Response(null, { status: 204 });
  } catch (error) {
    voiceLog("error", "twilio.status_failed", { error: voiceError(error) });
    return apiError(error);
  }
}
