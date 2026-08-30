import { z } from "zod";
import { initiateOutboundBatch } from "@/lib/call-service";
import { loadTelephonyConfig } from "@/lib/config";
import { apiError } from "@/lib/http";
import { getRepository } from "@/lib/repository";
import { TwilioTelephonyProvider } from "@/lib/telephony";
import { assertVoiceReady } from "@/lib/voice-readiness";
import { voiceError, voiceLog } from "@/lib/voice-log";

export const runtime = "nodejs";

const requestSchema = z.object({ contactIds: z.array(z.string().uuid()).min(1).max(3) });

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    voiceLog("info", "outbound.batch_requested", { contactIds: body.contactIds, contactCount: body.contactIds.length });
    const config = loadTelephonyConfig();
    await assertVoiceReady();
    voiceLog("info", "outbound.readiness_passed", { contactCount: body.contactIds.length });
    const result = await initiateOutboundBatch({
      contactIds: body.contactIds,
      fromNumber: config.phoneNumber,
      repository: getRepository(),
      provider: new TwilioTelephonyProvider(config),
    });
    voiceLog("info", "outbound.batch_started", { batchId: result.batchId, callIds: result.calls.map((call) => call.id) });
    return Response.json(result, { status: 202 });
  } catch (error) {
    voiceLog("error", "outbound.batch_failed", { error: voiceError(error) });
    return apiError(error);
  }
}
