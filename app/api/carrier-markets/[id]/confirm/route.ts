import { apiError } from "@/lib/http";
import { getVoiceControlService } from "@/lib/volta/service";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const call = await getVoiceControlService().startSelectedCarrierConfirmation(id);
    return Response.json({ call }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
