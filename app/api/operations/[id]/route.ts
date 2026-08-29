import { apiError } from "@/lib/http";
import { getVoiceControlService } from "@/lib/volta/service";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const snapshot = getVoiceControlService().getOperationSnapshot(id);
    if (!snapshot) return Response.json({ error: "Operation not found." }, { status: 404 });
    return Response.json(snapshot);
  } catch (error) {
    return apiError(error);
  }
}
