import { apiError } from "@/lib/http";
import { getVoiceReadiness } from "@/lib/voice-readiness";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const force = new URL(request.url).searchParams.get("refresh") === "1";
    const readiness = await getVoiceReadiness({ force });
    return Response.json(readiness, { status: readiness.ready ? 200 : 503 });
  } catch (error) {
    return apiError(error);
  }
}
