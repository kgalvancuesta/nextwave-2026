import "server-only";

import twilio from "twilio";
import type { TelephonyConfig } from "./config";

export async function parseTwilioForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}

export function validateTwilioWebhook(
  request: Request,
  params: Record<string, string>,
  config: TelephonyConfig,
): boolean {
  if (!config.validateSignatures) return true;
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return false;
  const requested = new URL(request.url);
  const publicUrl = `${config.publicBaseUrl}${requested.pathname}${requested.search}`;
  return twilio.validateRequest(config.authToken, signature, publicUrl, params);
}
