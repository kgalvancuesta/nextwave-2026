import type { CommitmentProposal, Mandate, MandateDecision } from "./models.js";

export function evaluateMandate(mandate: Mandate, proposal: CommitmentProposal): MandateDecision {
  const violations: string[] = [];

  if (proposal.rate.currency !== mandate.currency) {
    violations.push(`currency ${proposal.rate.currency} does not match mandate ${mandate.currency}`);
  }
  if (proposal.rate.amount < mandate.rate.min || proposal.rate.amount > mandate.rate.max) {
    violations.push(`rate ${proposal.rate.amount} is outside ${mandate.rate.min}-${mandate.rate.max}`);
  }

  const proposedStart = Date.parse(proposal.pickupWindow.start);
  const proposedEnd = Date.parse(proposal.pickupWindow.end);
  const mandateStart = Date.parse(mandate.pickupWindow.earliest);
  const mandateEnd = Date.parse(mandate.pickupWindow.latest);
  if (proposedStart < mandateStart || proposedEnd > mandateEnd || proposedEnd < proposedStart) {
    violations.push("pickup window is outside the mandate");
  }

  const allowedAccessorials = new Set(mandate.allowedAccessorials.map(normalize));
  for (const accessorial of proposal.accessorials) {
    if (!allowedAccessorials.has(normalize(accessorial))) {
      violations.push(`accessorial is not allowed: ${accessorial}`);
    }
  }

  for (const term of proposal.terms) {
    for (const prohibited of mandate.prohibitedTerms) {
      if (normalize(term).includes(normalize(prohibited))) {
        violations.push(`term contains prohibited condition: ${prohibited}`);
      }
    }
  }

  if (
    mandate.maxDetentionMinutes !== undefined &&
    proposal.detentionMinutes !== undefined &&
    proposal.detentionMinutes > mandate.maxDetentionMinutes
  ) {
    violations.push(`detention ${proposal.detentionMinutes} exceeds ${mandate.maxDetentionMinutes} minutes`);
  }

  return { allowed: violations.length === 0, violations };
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}
