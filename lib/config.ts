import "server-only";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export interface TwilioCredentials {
  accountSid: string;
  authToken: string | null;
  apiKeySid: string | null;
  apiKeySecret: string | null;
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
  const fileCredentials = process.env.TWILIO_CREDENTIALS_FILE
    ? readCredentialsMarkdown(process.env.TWILIO_CREDENTIALS_FILE)
    : {};
  const credentials = {
    accountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || fileCredentials.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN?.trim() || fileCredentials.TWILIO_AUTH_TOKEN,
    apiKeySid: process.env.TWILIO_API_KEY_SID?.trim() || fileCredentials.TWILIO_API_KEY_SID,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET?.trim() || fileCredentials.TWILIO_API_KEY_SECRET,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER?.trim() || fileCredentials.TWILIO_PHONE_NUMBER,
  };
  const missing = (["accountSid", "phoneNumber"] as const).filter((key) => !credentials[key]);
  if (missing.length > 0) {
    throw new Error(`Missing Twilio credentials: ${missing.join(", ")}. Set environment variables or TWILIO_CREDENTIALS_FILE.`);
  }
  const hasAuthToken = Boolean(credentials.authToken);
  const hasApiKey = Boolean(credentials.apiKeySid && credentials.apiKeySecret);
  if (!hasAuthToken && !hasApiKey) {
    throw new Error("Twilio REST authentication requires TWILIO_AUTH_TOKEN or both TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET.");
  }

  const publicBaseUrl = parsePublicBaseUrl(process.env.PUBLIC_BASE_URL);
  const validateSignatures = envBoolean.parse(process.env.TWILIO_VALIDATE_SIGNATURES?.trim().toLowerCase() || "true");
  if (validateSignatures && !hasAuthToken) {
    throw new Error("Twilio webhook signature validation requires TWILIO_AUTH_TOKEN; an API key cannot validate webhook signatures.");
  }
  if (process.env.NODE_ENV === "production" && !validateSignatures) {
    throw new Error("TWILIO_VALIDATE_SIGNATURES=false is forbidden in production.");
  }

  return {
    accountSid: credentials.accountSid!,
    authToken: credentials.authToken || null,
    apiKeySid: credentials.apiKeySid || null,
    apiKeySecret: credentials.apiKeySecret || null,
    phoneNumber: credentials.phoneNumber!,
    publicBaseUrl,
    validateSignatures,
    recordCalls: envBoolean.parse(process.env.RECORD_CALLS?.trim().toLowerCase() || "false"),
  };
}

export interface VoltaConfig {
  openAiApiKey: string;
  openAiWebhookSecret: string;
  projectId: string | null;
  realtimeModel: string;
  transcriptionModel: string;
  voice: string;
  /** The OpenAI Realtime SIP endpoint Twilio bridges answered calls into. */
  sipUri: string;
  humanEscalationUri: string | null;
}

/**
 * The voice agent is optional: the telephony dashboard runs without it. Every
 * caller that needs the agent asks for this config explicitly and fails loudly
 * rather than silently answering a carrier with no negotiation policy loaded.
 */
export function loadVoltaConfig(): VoltaConfig {
  const fileCredentials = readOpenAiCredentialsFile(process.env.OPENAI_CREDENTIALS_FILE);
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim()
    || readSecretFile(process.env.OPENAI_API_KEY_FILE)
    || fileCredentials.apiKey;
  const openAiWebhookSecret = process.env.OPENAI_WEBHOOK_SECRET?.trim()
    || fileCredentials.webhookSecret;
  const projectId = process.env.OPENAI_PROJECT_ID?.trim() || fileCredentials.projectId;
  const sipUri = process.env.OPENAI_SIP_URI?.trim()
    || fileCredentials.sipUri
    || (projectId ? `sip:${projectId}@sip.api.openai.com;transport=tls` : undefined);
  const missing = [
    openAiApiKey ? null : "OPENAI_API_KEY",
    openAiWebhookSecret ? null : "OPENAI_WEBHOOK_SECRET",
    sipUri ? null : "OPENAI_SIP_URI",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(`Missing OpenAI voice configuration: ${missing.join(", ")}.`);
  }

  return {
    openAiApiKey: openAiApiKey!,
    openAiWebhookSecret: openAiWebhookSecret!,
    projectId: projectId || null,
    realtimeModel: process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2.1",
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-transcribe",
    voice: process.env.OPENAI_VOICE?.trim() || "marin",
    sipUri: sipUri!,
    humanEscalationUri: process.env.HUMAN_ESCALATION_URI?.trim() || null,
  };
}

interface OpenAiFileCredentials {
  apiKey?: string;
  projectId?: string;
  webhookSecret?: string;
  sipUri?: string;
}

function readOpenAiCredentialsFile(path: string | undefined): OpenAiFileCredentials {
  if (!path?.trim()) return {};
  const content = readFileSync(resolve(path.trim()), "utf8");
  return {
    apiKey: credentialValue(content, "OPENAI_API_KEY", /\bsk-[A-Za-z0-9_-]+\b/),
    projectId: credentialValue(content, "OPENAI_PROJECT_ID", /\bproj_[A-Za-z0-9_-]+\b/),
    webhookSecret: credentialValue(content, "OPENAI_WEBHOOK_SECRET", /\bwhsec_[A-Za-z0-9_+/=-]+/),
    sipUri: credentialValue(content, "OPENAI_SIP_URI", /\bsips?:[^\s`]+/),
  };
}

function credentialValue(content: string, name: string, fallbackPattern: RegExp): string | undefined {
  const labeled = content.match(new RegExp(`^\\s*(?:[-*]\\s*)?${name}\\s*[:=]\\s*(?:\\x60)?([^\\x60\\r\\n]+)(?:\\x60)?\\s*$`, "m"));
  return labeled?.[1]?.trim() || content.match(fallbackPattern)?.[0];
}

function readSecretFile(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined;
  return readFileSync(resolve(path.trim()), "utf8").trim() || undefined;
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

type CredentialKey = "TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN" | "TWILIO_API_KEY_SID" | "TWILIO_API_KEY_SECRET" | "TWILIO_PHONE_NUMBER";

function readCredentialsMarkdown(path: string): Partial<Record<CredentialKey, string>> {
  const content = readFileSync(resolve(path), "utf8");
  const result: Partial<Record<CredentialKey, string>> = {};
  for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_PHONE_NUMBER"] as const) {
    const match = content.match(new RegExp(`^\\s*(?:[-*]\\s*)?${key}\\s*[:=]\\s*(?:\\x60)?([^\\x60\\r\\n]+)(?:\\x60)?\\s*$`, "m"));
    if (match?.[1]) result[key] = match[1].trim();
  }
  return result;
}
