export const runtime = "nodejs";

export async function GET() {
  return Response.json({ service: "marketline", live: true });
}
