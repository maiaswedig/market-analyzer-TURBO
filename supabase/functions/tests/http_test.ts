import { HttpError, validateInternalCredentials } from "../_shared/http.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fakeJwt(role: string): string {
  const payload = btoa(JSON.stringify({ role }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  // Signature verification is the gateway's job.  This fixture verifies only
  // the application-level role gate that runs after verify_jwt=true.
  return `fixture.${payload}.gateway-signature-fixture`;
}

async function expectHttpError(action: () => Promise<void>, status: number): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof HttpError, "expected HttpError");
    assert(error.status === status, `expected ${status}, received ${error.status}`);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

Deno.test("internal auth rejects an ordinary authenticated user JWT", async () => {
  await expectHttpError(
    () => validateInternalCredentials(`Bearer ${fakeJwt("authenticated")}`, "a".repeat(48), "a".repeat(48)),
    403,
  );
});

Deno.test("internal auth rejects a wrong dedicated cron secret", async () => {
  await expectHttpError(
    () => validateInternalCredentials(`Bearer ${fakeJwt("service_role")}`, "a".repeat(48), "b".repeat(48)),
    403,
  );
});

Deno.test("internal auth accepts service_role plus the dedicated cron secret", async () => {
  const secret = "internal-cron-fixture-".padEnd(48, "x");
  await validateInternalCredentials(`Bearer ${fakeJwt("service_role")}`, secret, secret);
});

Deno.test("internal auth accepts the documented anon cron JWT only with the dedicated secret", async () => {
  const secret = "internal-cron-fixture-".padEnd(48, "x");
  await validateInternalCredentials(`Bearer ${fakeJwt("anon")}`, secret, secret);
});

Deno.test("a public anon JWT alone never authorizes the worker", async () => {
  await expectHttpError(
    () => validateInternalCredentials(`Bearer ${fakeJwt("anon")}`, "", "a".repeat(48)),
    403,
  );
});

Deno.test("internal auth fails closed when the Edge secret is absent", async () => {
  await expectHttpError(
    () => validateInternalCredentials(`Bearer ${fakeJwt("service_role")}`, "a".repeat(48), ""),
    503,
  );
});
