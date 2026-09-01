export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const CRON_SECRET_HEADER = "x-signal-atlas-cron-secret";

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new HttpError(401, "Credencial interna inválida.");
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("payload inválido");
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "Credencial interna inválida.");
  }
}

async function constantTimeSecretEquals(received: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(receivedHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

/**
 * Second authorization layer for private worker functions.
 *
 * `verify_jwt=true` validates the JWT signature at the Supabase gateway.  This
 * code then rejects ordinary `authenticated` user JWTs and requires a separate
 * high-entropy secret shared only by the Edge Functions and the Vault-backed
 * pg_cron jobs.  `anon` is accepted because Supabase's documented scheduler
 * pattern uses a public JWT; that token has no authority without the second
 * secret.  The payload decoder below is deliberately not a signature verifier;
 * it may only be trusted behind the versioned gateway setting.
 */
export async function validateInternalCredentials(
  authorization: string,
  receivedCronSecret: string,
  expectedCronSecret: string,
): Promise<void> {
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw new HttpError(401, "Credencial interna obrigatória.");
  const claims = decodeJwtPayload(match[1]);
  if (claims.role !== "anon" && claims.role !== "service_role") {
    throw new HttpError(403, "Esta função aceita somente o worker interno.");
  }
  if (expectedCronSecret.length < 32 || expectedCronSecret.length > 512) {
    throw new HttpError(503, "Autenticação interna não configurada.");
  }
  if (!receivedCronSecret || receivedCronSecret.length > 512 ||
    !await constantTimeSecretEquals(receivedCronSecret, expectedCronSecret)) {
    throw new HttpError(403, "Esta função aceita somente o worker interno.");
  }
}

export async function requireInternalPost(request: Request): Promise<void> {
  if (request.method !== "POST") throw new HttpError(405, "Use POST para esta função.");
  const expectedCronSecret = Deno.env.get("SIGNAL_ATLAS_CRON_SECRET")?.trim() || "";
  await validateInternalCredentials(
    request.headers.get("authorization") || "",
    request.headers.get(CRON_SECRET_HEADER)?.trim() || "",
    expectedCronSecret,
  );
}

export async function readJson<T extends Record<string, unknown>>(request: Request): Promise<Partial<T>> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Partial<T> : {};
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

export class HttpError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export async function handleFunction(request: Request, handler: () => Promise<unknown>): Promise<Response> {
  try {
    await requireInternalPost(request);
    return jsonResponse(await handler());
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, status);
  }
}
