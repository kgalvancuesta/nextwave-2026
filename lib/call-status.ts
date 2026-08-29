import type { CallStatus } from "./types";

const terminalStatuses = new Set<CallStatus>(["COMPLETED", "BUSY", "NO_ANSWER", "FAILED", "CANCELED"]);

export function mapTwilioCallStatus(status: string | undefined): CallStatus {
  switch (status?.trim().toLowerCase()) {
    case "queued": return "REQUESTED";
    case "initiated": return "INITIATED";
    case "ringing": return "RINGING";
    case "answered":
    case "in-progress": return "IN_PROGRESS";
    case "completed": return "COMPLETED";
    case "busy": return "BUSY";
    case "no-answer": return "NO_ANSWER";
    case "failed": return "FAILED";
    case "canceled": return "CANCELED";
    default: return "REQUESTED";
  }
}

export function callStatusRank(status: CallStatus): number {
  if (status === "REQUESTED") return 0;
  if (status === "INITIATED") return 1;
  if (status === "RINGING") return 2;
  if (status === "IN_PROGRESS") return 3;
  return 4;
}

export function isTerminalCallStatus(status: CallStatus): boolean {
  return terminalStatuses.has(status);
}

export function isActiveCallStatus(status: CallStatus): boolean {
  return !isTerminalCallStatus(status);
}
