export async function requestJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  if (response.status === 204) return undefined as T;
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed with status ${response.status}.`);
  return data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
