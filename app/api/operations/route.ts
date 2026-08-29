import { apiError } from "@/lib/http";
import { getVoiceControlService } from "@/lib/volta/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const operation = getVoiceControlService().createOperation(await request.json());
    return Response.json({ operation }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
