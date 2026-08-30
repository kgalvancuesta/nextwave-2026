/**
 * twilio-configure.ts
 *
 * Configures the Twilio phone number's inbound voice webhook and status callback
 * to point at the currently active PUBLIC_BASE_URL.
 *
 * Usage:
 *   npm run twilio:configure
 *   PUBLIC_BASE_URL=https://your-tunnel.example.com npm run twilio:configure
 *
 * Requirements:
 *   TWILIO_ACCOUNT_SID and either TWILIO_AUTH_TOKEN or both TWILIO_API_KEY_SID
 *   and TWILIO_API_KEY_SECRET must be set (in .env.local or environment).
 *   TWILIO_PHONE_NUMBER must identify the number to configure.
 *   PUBLIC_BASE_URL must be the externally reachable HTTPS origin.
 *
 * Never prints credentials.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import twilio from "twilio";

// ---------------------------------------------------------------------------
// Load .env.local if it exists (mirrors the app's credential loading approach)
// ---------------------------------------------------------------------------
function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(resolve(path), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx);
      const value = trimmed.slice(idx + 1);
      // Only set if not already in process.env (real env vars take precedence)
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env.local is optional
  }
}

loadEnvFile(".env.local");

// ---------------------------------------------------------------------------
// Read and validate configuration
// ---------------------------------------------------------------------------
const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || null;
const apiKeySid = process.env.TWILIO_API_KEY_SID?.trim() || null;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim() || null;
const phoneNumber = process.env.TWILIO_PHONE_NUMBER?.trim();
const rawPublicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();

if (!accountSid) { console.error("Error: TWILIO_ACCOUNT_SID is required."); process.exit(1); }
if (!phoneNumber) { console.error("Error: TWILIO_PHONE_NUMBER is required."); process.exit(1); }
if (!authToken && !(apiKeySid && apiKeySecret)) {
  console.error("Error: Twilio REST authentication requires TWILIO_AUTH_TOKEN or both TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET.");
  process.exit(1);
}
if (!rawPublicBaseUrl) { console.error("Error: PUBLIC_BASE_URL is required."); process.exit(1); }

let publicBaseUrl: string;
try {
  const url = new URL(rawPublicBaseUrl);
  if (url.protocol !== "https:") { console.error("Error: PUBLIC_BASE_URL must use HTTPS."); process.exit(1); }
  publicBaseUrl = url.toString().replace(/\/$/, "");
} catch {
  console.error("Error: PUBLIC_BASE_URL is not a valid URL:", rawPublicBaseUrl);
  process.exit(1);
}

const voiceUrl = `${publicBaseUrl}/api/twilio/voice/inbound`;
const statusCallbackUrl = `${publicBaseUrl}/api/twilio/status`;

// ---------------------------------------------------------------------------
// Twilio client
// ---------------------------------------------------------------------------
const client = apiKeySid && apiKeySecret
  ? twilio(apiKeySid, apiKeySecret, { accountSid })
  : twilio(accountSid, authToken!);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("Semantiks — Twilio phone number configurator");
console.log("─".repeat(50));
console.log("Phone number :", phoneNumber);
console.log("Voice URL    :", voiceUrl);
console.log("Status CB    :", statusCallbackUrl);
console.log("");

try {
  // Find the IncomingPhoneNumber resource
  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber });
  if (numbers.length === 0) {
    console.error(`Error: Phone number ${phoneNumber} was not found in this Twilio account.`);
    process.exit(1);
  }

  const numSid = numbers[0]!.sid;

  // Show current configuration
  const current = numbers[0]!;
  console.log("Current configuration:");
  console.log("  SID         :", numSid);
  console.log("  VoiceUrl    :", current.voiceUrl || "(empty)");
  console.log("  VoiceMethod :", current.voiceMethod);
  console.log("  AppSid      :", current.voiceApplicationSid || "(none)");
  console.log("  StatusCB    :", current.statusCallback || "(empty)");
  console.log("");

  // Apply the update
  console.log("Applying update...");
  await client.incomingPhoneNumbers(numSid).update({
    voiceUrl,
    voiceMethod: "POST",
    // Clear any TwiML App that might override VoiceUrl
    voiceApplicationSid: "",
    statusCallback: statusCallbackUrl,
    statusCallbackMethod: "POST",
  });

  // Verify by reading back
  const verified = await client.incomingPhoneNumbers(numSid).fetch();
  console.log("Verified configuration:");
  console.log("  VoiceUrl    :", verified.voiceUrl);
  console.log("  VoiceMethod :", verified.voiceMethod);
  console.log("  AppSid      :", verified.voiceApplicationSid || "(none)");
  console.log("  StatusCB    :", verified.statusCallback);
  console.log("");

  if (verified.voiceUrl !== voiceUrl) {
    console.error("VERIFICATION FAILED: VoiceUrl was not updated correctly.");
    process.exit(1);
  }
  if (verified.voiceApplicationSid) {
    console.warn("WARNING: A VoiceApplicationSid is still set — it may override VoiceUrl.");
    console.warn("  AppSid:", verified.voiceApplicationSid);
    console.warn("  Update the TwiML App's Voice Request URL in the Twilio Console if calls still fail.");
  }

  console.log("✓ Twilio number configured successfully.");
  console.log("  Real calls to", phoneNumber, "will now reach:");
  console.log("  →", voiceUrl);
} catch (err) {
  const e = err as { message?: string; code?: number; status?: number };
  if (e.code === 20003 || e.status === 401) {
    console.error("Authentication failed. Check Twilio credentials.");
  } else {
    console.error("Twilio API error:", e.message || String(err));
  }
  process.exit(1);
}
