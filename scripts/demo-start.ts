import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

const projectDirectory = process.cwd();
loadEnvConfig(projectDirectory);

const publicBaseUrl = requiredUrl("PUBLIC_BASE_URL");
if (publicBaseUrl.hostname.endsWith(".trycloudflare.com")) {
  fail("PUBLIC_BASE_URL must use a stable named-tunnel hostname; trycloudflare.com is forbidden for demo startup.");
}

const configuredWebhookUrl = process.env.OPENAI_WEBHOOK_URL?.trim().replace(/\/$/, "");
const expectedWebhookUrl = `${publicBaseUrl.toString().replace(/\/$/, "")}/api/webhooks/openai`;
if (configuredWebhookUrl !== expectedWebhookUrl) {
  fail(`OPENAI_WEBHOOK_URL must equal ${expectedWebhookUrl}.`);
}

const credentialsFileValue = process.env.CLOUDFLARE_TUNNEL_CREDENTIALS_FILE?.trim();
const tunnelId = process.env.CLOUDFLARE_TUNNEL_ID?.trim();
const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim();
if ((!credentialsFileValue || !tunnelId) && !tunnelToken) {
  fail("Set CLOUDFLARE_TUNNEL_CREDENTIALS_FILE and CLOUDFLARE_TUNNEL_ID, or set CLOUDFLARE_TUNNEL_TOKEN.");
}

const credentialsFile = credentialsFileValue ? resolve(projectDirectory, credentialsFileValue) : null;
if (credentialsFile && !existsSync(credentialsFile)) fail(`Tunnel credentials file does not exist: ${credentialsFile}`);

const children: ChildProcess[] = [];
let shuttingDown = false;

function start(command: string, args: string[], environment = process.env): ChildProcess {
  const child = spawn(command, args, {
    cwd: projectDirectory,
    env: environment,
    stdio: "inherit",
  });
  children.push(child);
  return child;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: projectDirectory, env: process.env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code}.`)));
  });
}

function shutdown(signal: NodeJS.Signals = "SIGTERM"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  start("npm", ["run", "dev"]);

  const tunnelArgs = [
    "tunnel",
    "--no-autoupdate",
    "--protocol", "http2",
    "run",
    ...(credentialsFile ? ["--credentials-file", credentialsFile, tunnelId!] : []),
  ];
  const tunnelEnvironment = tunnelToken
    ? { ...process.env, TUNNEL_TOKEN: tunnelToken }
    : process.env;
  start("cloudflared", tunnelArgs, tunnelEnvironment);

  await waitFor("http://127.0.0.1:3000/api/health/live", 60_000);
  await waitFor(`${publicBaseUrl.toString().replace(/\/$/, "")}/api/health/live`, 60_000);
  await run("npm", ["run", "twilio:configure"]);
  await run("npm", ["run", "demo:check"]);

  console.log("");
  console.log("Marketline demo system is READY.");
  console.log("Dashboard: http://localhost:3000");
  console.log(`Public origin: ${publicBaseUrl.origin}`);
  console.log("Press Ctrl+C to stop the app and tunnel together.");

  await Promise.race(children.map((child) => new Promise<never>((_, rejectChild) => {
    child.once("error", rejectChild);
    child.once("exit", (code, signal) => rejectChild(new Error(`A required process stopped (${signal ?? code ?? "unknown"}).`)));
  })));
} catch (error) {
  shutdown();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000), cache: "no-store" });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function requiredUrl(name: string): URL {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") fail(`${name} must use HTTPS.`);
    return url;
  } catch {
    fail(`${name} must be a valid HTTPS URL.`);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
