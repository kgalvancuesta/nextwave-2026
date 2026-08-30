export {};

const response = await fetch("http://127.0.0.1:3000/api/health/voice?refresh=1", {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(20_000),
});

const readiness = await response.json() as {
  ready?: boolean;
  checkedAt?: string;
  checks?: Array<{ id: string; ok: boolean; message: string }>;
  error?: string;
};

console.log("Marketline voice readiness");
for (const check of readiness.checks ?? []) {
  console.log(`${check.ok ? "[PASS]" : "[FAIL]"} ${check.id}: ${check.message}`);
}

if (!response.ok || !readiness.ready) {
  if (readiness.error) console.error(`[FAIL] ${readiness.error}`);
  process.exit(1);
}

console.log(`[READY] All voice dependencies passed at ${readiness.checkedAt}.`);
