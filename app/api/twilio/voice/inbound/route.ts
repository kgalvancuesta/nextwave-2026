import { handleInboundCall } from "@/lib/call-service";
import { loadTelephonyConfig } from "@/lib/config";
import { apiError, twimlResponse } from "@/lib/http";
import { getRepository } from "@/lib/repository";
import { TwilioTelephonyProvider } from "@/lib/telephony";
import { parseTwilioForm, validateTwilioWebhook } from "@/lib/twilio-webhook";
import { resolveVoiceSession } from "@/lib/voice-session";
import { voiceError, voiceLog } from "@/lib/voice-log";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = loadTelephonyConfig();
    const params = await parseTwilioForm(request);
    voiceLog("info", "twilio.inbound_voice_received", {
      twilioCallSid: params.CallSid,
      status: params.CallStatus,
      direction: params.Direction,
      from: params.From,
      to: params.To,
    });
    if (!validateTwilioWebhook(request, params, config)) {
      voiceLog("warn", "twilio.inbound_voice_rejected", { path: new URL(request.url).pathname, twilioCallSid: params.CallSid });
      return Response.json({ error: "Invalid Twilio signature." }, { status: 403 });
    }
    const result = await handleInboundCall({
      params,
      repository: getRepository(),
      voiceSession: resolveVoiceSession(),
      recordingEnabled: config.recordCalls,
    });
    voiceLog("info", "twilio.inbound_voice_bridged", {
      callId: result.call.id,
      twilioCallSid: result.call.twilioCallSid,
      recordingEnabled: config.recordCalls,
    });
    if (config.recordCalls) {
      try {
        await new TwilioTelephonyProvider(config).startRecording(result.call.twilioCallSid!);
      } catch (error) {
        voiceLog("error", "twilio.inbound_recording_failed", { callId: result.call.id, error: voiceError(error) });
      }
    }
    return twimlResponse(result.response.body);
  } catch (error) {
    voiceLog("error", "twilio.inbound_voice_failed", { error: voiceError(error) });
    return apiError(error);
  }
}
