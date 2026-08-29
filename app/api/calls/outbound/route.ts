import { z } from "zod";
import { initiateOutboundBatch } from "@/lib/call-service";
import { loadTelephonyConfig } from "@/lib/config";
import { apiError } from "@/lib/http";
import { getRepository } from "@/lib/repository";
import { TwilioTelephonyProvider } from "@/lib/telephony";

export const runtime = "nodejs";

const requestSchema = z.object({ contactIds: z.array(z.string().uuid()).min(1).max(3) });

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const config = loadTelephonyConfig();
    const result = await initiateOutboundBatch({
      contactIds: body.contactIds,
      fromNumber: config.phoneNumber,
      repository: getRepository(),
      provider: new TwilioTelephonyProvider(config),
    });
    return Response.json(result, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
