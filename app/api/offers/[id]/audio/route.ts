import { loadTelephonyConfig } from "@/lib/config";
import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";

export const runtime = "nodejs";

/**
 * Streams the call recording behind one offer version. Twilio media requires
 * account credentials, so the raw provider URL is never handed to the browser;
 * the dashboard's own basic-auth proxy already guards `/api/offers/*`, which
 * keeps carrier audio behind exactly one door.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const evidence = getOrderMarketService().getOfferRecording(id);
    if (!evidence) return Response.json({ error: "No recording exists for this offer." }, { status: 404 });

    const config = loadTelephonyConfig();
    const credentials = config.apiKeySid && config.apiKeySecret
      ? `${config.apiKeySid}:${config.apiKeySecret}`
      : `${config.accountSid}:${config.authToken}`;
    const range = request.headers.get("range");
    const upstream = await fetch(`${evidence.recordingUrl}.mp3`, {
      headers: {
        authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
        ...(range ? { range } : {}),
      },
    });
    if (!upstream.ok || !upstream.body) {
      return Response.json({ error: `The recording could not be retrieved (${upstream.status}).` }, { status: 502 });
    }

    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") || "audio/mpeg",
      "accept-ranges": "bytes",
      // Recordings are immutable once Twilio publishes them, but they are also
      // carrier audio: cache in the browser only, never in a shared proxy.
      "cache-control": "private, max-age=3600",
      "x-evidence-offset-ms": String(evidence.offsetMs ?? 0),
    });
    for (const header of ["content-length", "content-range"]) {
      const value = upstream.headers.get(header);
      if (value) headers.set(header, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return apiError(error);
  }
}
