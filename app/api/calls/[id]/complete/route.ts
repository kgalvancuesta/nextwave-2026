import { apiError } from "@/lib/http";
import { getVoiceControlService } from "@/lib/volta/service";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json({ outcomes: await getVoiceControlService().completeCall(id) });
  } catch (error) {
    return apiError(error);
  }
}
