import { z } from "zod";
import { apiError } from "@/lib/http";
import { normalizePhoneNumber } from "@/lib/phone";
import { getVoiceControlService } from "@/lib/volta/service";
import { assertVoiceReady } from "@/lib/voice-readiness";

export const runtime = "nodejs";

const requestSchema = z.object({
  candidates: z.array(z.object({
    name: z.string().trim().min(1),
    phoneNumber: z.string().trim().min(1),
    reliabilityScore: z.number().min(0).max(100),
  })).min(3, "A carrier market needs at least three distinct carriers."),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = requestSchema.parse(await request.json());
    await assertVoiceReady();
    const result = await getVoiceControlService().startCarrierMarket(id, body.candidates.map((candidate) => ({
      name: candidate.name,
      phone: normalizePhoneNumber(candidate.phoneNumber),
      reliabilityScore: candidate.reliabilityScore,
    })));
    return Response.json(result, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
