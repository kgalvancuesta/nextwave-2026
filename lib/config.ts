import "server-only";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

export interface TelephonyConfig extends TwilioCredentials {
  publicBaseUrl: string;
  validateSignatures: boolean;
  recordCalls: boolean;
}

const envBoolean = z.enum(["true", "false"]).transform((value) => value === "true");

export function getDatabasePath(): string {
  return resolve(process.env.DATABASE_PATH?.trim() || "./data/marketline.db");
}

export function loadTelephonyConfig(): TelephonyConfig {
  const hasEnvironmentCredentials = Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
    process.env.TWILIO_AUTH_TOKEN?.trim() &&
    process.env.TWILIO_PHONE_NUMBER?.trim(),
  );
  const fileCredentials = !hasEnvironmentCredentials && process.env.TWILIO_CREDENTIALS_FILE
    ? readCredentialsMarkdown(process.env.TWILIO_CREDENTIALS_FILE)
    : {};
  const credentials = {
    accountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || fileCredentials.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN?.trim() || fileCredentials.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER?.trim() || fileCredentials.TWILIO_PHONE_NUMBER,
  };
  const missing = Object.entries(credentials).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing Twilio credentials: ${missing.join(", ")}. Set environment variables or TWILIO_CREDENTIALS_FILE.`);
  }

  const publicBaseUrl = parsePublicBaseUrl(process.env.PUBLIC_BASE_URL);
  const validateSignatures = envBoolean.parse(process.env.TWILIO_VALIDATE_SIGNATURES?.trim().toLowerCase() || "true");
  if (process.env.NODE_ENV === "production" && !validateSignatures) {
    throw new Error("TWILIO_VALIDATE_SIGNATURES=false is forbidden in production.");
  }

  return {
    accountSid: credentials.accountSid!,
    authToken: credentials.authToken!,
    phoneNumber: credentials.phoneNumber!,
    publicBaseUrl,
    validateSignatures,
    recordCalls: envBoolean.parse(process.env.RECORD_CALLS?.trim().toLowerCase() || "false"),
  };
}

function parsePublicBaseUrl(input: string | undefined): string {
  if (!input?.trim()) throw new Error("PUBLIC_BASE_URL is required for Twilio callbacks.");
  const url = new URL(input.trim());
  if (url.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use HTTPS.");
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("PUBLIC_BASE_URL must be the externally reachable HTTPS tunnel URL, not localhost.");
  }
  return url.toString().replace(/\/$/, "");
}

function readCredentialsMarkdown(path: string): Partial<Record<"TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN" | "TWILIO_PHONE_NUMBER", string>> {
  const content = readFileSync(resolve(path), "utf8");
  const result: Partial<Record<"TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN" | "TWILIO_PHONE_NUMBER", string>> = {};
  for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"] as const) {
    const match = content.match(new RegExp(`^\\s*(?:[-*]\\s*)?${key}\\s*[:=]\\s*(?:\\x60)?([^\\x60\\r\\n]+)(?:\\x60)?\\s*$`, "m"));
    if (match?.[1]) result[key] = match[1].trim();
  }
  return result;
}
