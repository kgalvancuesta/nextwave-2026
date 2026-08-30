import { handleOutboundAnswer } from "@/lib/call-service";
import { loadTelephonyConfig } from "@/lib/config";
import { apiError, twimlResponse } from "@/lib/http";
import { getRepository } from "@/lib/repository";
import { parseTwilioForm, validateTwilioWebhook } from "@/lib/twilio-webhook";
import { resolveVoiceSession } from "@/lib/voice-session";
import { voiceError, voiceLog } from "@/lib/voice-log";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = loadTelephonyConfig();
    const params = await parseTwilioForm(request);
    const internalCallId = new URL(request.url).searchParams.get("callId");
    voiceLog("info", "twilio.outbound_answer_received", {
      callId: internalCallId,
      twilioCallSid: params.CallSid,
      status: params.CallStatus,
      from: params.From,
      to: params.To,
    });
    if (!validateTwilioWebhook(request, params, config)) {
      voiceLog("warn", "twilio.outbound_answer_rejected", { callId: internalCallId, twilioCallSid: params.CallSid });
      return Response.json({ error: "Invalid Twilio signature." }, { status: 403 });
    }
    if (internalCallId && params.CallSid) getRepository().attachTwilioSidIfMissing(internalCallId, params.CallSid);
    const response = await handleOutboundAnswer({
      params,
      repository: getRepository(),
      voiceSession: resolveVoiceSession(),
      recordingEnabled: config.recordCalls,
    });
    voiceLog("info", "twilio.outbound_answer_bridged", { callId: internalCallId, twilioCallSid: params.CallSid });
    return twimlResponse(response.body);
  } catch (error) {
    voiceLog("error", "twilio.outbound_answer_failed", { error: voiceError(error) });
    return apiError(error);
  }
}
