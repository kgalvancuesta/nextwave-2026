import { PhoneNumberError } from "./phone";
import { ZodError } from "zod";

export function apiError(error: unknown): Response {
  const candidate = error as { code?: string; message?: string };
  const message = candidate.message || "Unexpected server error.";
  if (error instanceof PhoneNumberError) return Response.json({ error: message }, { status: 400 });
  if (error instanceof ZodError) {
    return Response.json({ error: error.issues[0]?.message || "Invalid request." }, { status: 400 });
  }
  if (candidate.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
    return Response.json({ error: "This carrier is already used by an order and cannot be deleted." }, { status: 409 });
  }
  if (candidate.code?.startsWith("SQLITE_CONSTRAINT")) {
    return Response.json({ error: "That phone number is already saved." }, { status: 409 });
  }
  if (/not found/i.test(message)) return Response.json({ error: message }, { status: 404 });
  if (/already has an active commitment|already been started/i.test(message)) return Response.json({ error: message }, { status: 409 });
  if (/Select between|no longer exist|omitted|valid phone/i.test(message)) {
    return Response.json({ error: message }, { status: 400 });
  }
  if (/market|offer|carrier|commitment|price|weight|mandate|invalidation reason|required before/i.test(message)) {
    return Response.json({ error: message }, { status: 400 });
  }
  if (/Missing Twilio|PUBLIC_BASE_URL|forbidden in production/i.test(message)) {
    return Response.json({ error: message }, { status: 503 });
  }
  if (/no such table/i.test(message)) {
    return Response.json({ error: "Database is not initialized. Run npm run db:migrate." }, { status: 503 });
  }
  console.error(error);
  return Response.json({ error: "The request failed. Check the server log for technical details." }, { status: 500 });
}

export function twimlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
}
