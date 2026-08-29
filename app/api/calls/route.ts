import { deriveInboundCallState, isActiveCallStatus } from "@/lib/call-status";
import { apiError } from "@/lib/http";
import { getRepository } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    const calls = getRepository().listCalls();
    return Response.json({
      activeCalls: calls.filter((call) => isActiveCallStatus(call.status)),
      recentCalls: calls.filter((call) => !isActiveCallStatus(call.status)),
      inboundState: deriveInboundCallState(calls),
    });
  } catch (error) {
    return apiError(error);
  }
}
