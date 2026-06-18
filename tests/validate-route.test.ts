import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POST } from "@/app/api/checkout/validate/route";
import { orderDigest } from "@/lib/checkout";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";
import { product } from "@/lib/config";

const VALID_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example";

function validateRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/checkout/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("checkout validate route", () => {
  it("returns protocol, methods, and quote without composing payment", async () => {
    const response = await POST(
      validateRequest({ duration_minutes: 60, ssh_public_key: VALID_KEY }),
    );
    const body = (await response.json()) as {
      protocol: string;
      valid: boolean;
      methods: Array<{ id: string }>;
      quote: { amount_cents: number };
      checkout_path: string;
    };

    assert.equal(response.status, 200);
    assert.equal(body.protocol, "mpp");
    assert.equal(body.valid, true);
    assert.equal(body.methods[0].id, "stripe-spt");
    assert.equal(body.checkout_path, "/api/checkout");
    assert.equal(typeof body.quote.amount_cents, "number");
  });

  it("echoes a supplied request_id so the agent can reuse it on checkout", async () => {
    const response = await POST(
      validateRequest({ duration_minutes: 60, ssh_public_key: VALID_KEY, request_id: "ord-123" }),
    );
    const body = (await response.json()) as { request_id?: string };

    assert.equal(response.status, 200);
    assert.equal(body.request_id, "ord-123");
  });

  it("does not create a payment or machine — pure preflight", async () => {
    // No MPP/Stripe secrets are configured in tests, yet validate still returns
    // 200. (createMppCheckout would throw 503 here — validate must not call it.)
    const response = await POST(
      validateRequest({ duration_minutes: 60, ssh_public_key: VALID_KEY }),
    );
    assert.equal(response.status, 200);
  });

  it("rejects an invalid order with 400 and valid:false", async () => {
    const response = await POST(
      validateRequest({ duration_minutes: 1, ssh_public_key: VALID_KEY }),
    );
    const body = (await response.json()) as { valid: boolean; error: string };

    assert.equal(response.status, 400);
    assert.equal(body.valid, false);
    assert.match(body.error, /duration_minutes/);
  });
});

describe("order binding (request_id / digest)", () => {
  it("binds the digest to ssh_public_key — same price, different key differs", () => {
    const base = { durationMinutes: 60, sshPublicKey: VALID_KEY };
    const other = { durationMinutes: 60, sshPublicKey: `${VALID_KEY}-2` };

    // Same duration => same amount, but the order digest must differ so an SPT
    // minted for one order cannot be replayed against the other.
    assert.notEqual(orderDigest(base), orderDigest(other));
  });

  it("is stable for an identical order — the paid retry reproduces the challenge", () => {
    const order = { durationMinutes: 60, sshPublicKey: VALID_KEY, requestId: "ord-123" };
    assert.equal(orderDigest(order), orderDigest({ ...order }));
  });

  it("changing request_id changes the binding", () => {
    const a = { durationMinutes: 60, sshPublicKey: VALID_KEY, requestId: "ord-a" };
    const b = { durationMinutes: 60, sshPublicKey: VALID_KEY, requestId: "ord-b" };
    assert.notEqual(orderDigest(a), orderDigest(b));
  });

  it("parses and normalizes request_id; rejects bad charset", () => {
    const parsed = parseCreateMachineRequest(
      { duration_minutes: 60, ssh_public_key: VALID_KEY, request_id: "  ord-123  " },
      product,
    );
    assert.equal(parsed.requestId, "ord-123");

    assert.throws(
      () =>
        parseCreateMachineRequest(
          { duration_minutes: 60, ssh_public_key: VALID_KEY, request_id: "bad id!" },
          product,
        ),
      ValidationError,
    );
  });
});
