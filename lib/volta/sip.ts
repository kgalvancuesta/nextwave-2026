/**
 * Builds the SIP URI Twilio dials to reach OpenAI Realtime. The correlation IDs
 * travel as custom SIP headers on the INVITE, issued by the server, so the
 * voice model is never asked which operation it is on. Existing headers with
 * the same names are replaced case-insensitively: a misconfigured base URI
 * cannot smuggle an ambiguous value ahead of the server's own.
 */
export function buildCorrelatedSipUri(input: {
  sipUri: string;
  internalCallId: string;
  operationId: string | null;
}): string {
  const target = requiredText("sipUri", input.sipUri);
  if (!/^sips?:/i.test(target)) throw new Error("sipUri must start with sip: or sips:");
  if (target.includes("#") || /\s/.test(target)) {
    throw new Error("sipUri must not contain fragments or whitespace");
  }

  const queryIndex = target.indexOf("?");
  const base = queryIndex === -1 ? target : target.slice(0, queryIndex);
  const existingQuery = queryIndex === -1 ? "" : target.slice(queryIndex + 1);
  if (base.length <= 4) throw new Error("sipUri must include a SIP destination");

  const retained = new URLSearchParams();
  for (const [name, value] of new URLSearchParams(existingQuery)) {
    const normalized = name.toLowerCase();
    if (normalized === "x-internal-call-id" || normalized === "x-operation-id") continue;
    retained.append(name, value);
  }
  retained.append("X-Internal-Call-ID", requiredText("internalCallId", input.internalCallId));
  if (input.operationId !== null) {
    retained.append("X-Operation-ID", requiredText("operationId", input.operationId));
  }

  return `${base}?${retained.toString()}`;
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&apos;";
    }
  });
}

function requiredText(name: string, value: string): string {
  if (!value || value.trim() !== value || hasControlCharacters(value)) {
    throw new Error(`${name} must be a non-empty single-line value without surrounding whitespace`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
