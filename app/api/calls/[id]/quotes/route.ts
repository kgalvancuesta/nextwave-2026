import { apiError } from "@/lib/http";
import { getVoiceControlService } from "@/lib/volta/service";

export const runtime = "nodejs";

/**
 * Records a carrier quote for a market call. The Realtime agent normally calls
 * this through its record_carrier_quote tool; the route exists so a demo can
 * drive the same validated path without a live phone call.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const quote = getVoiceControlService().recordCarrierQuote(id, await request.json());
    return Response.json({ quote }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
