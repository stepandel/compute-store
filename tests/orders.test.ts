import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POST as validatePost } from "@/app/api/machine/mpp/orders/validate/route";
import { POST as ordersPost } from "@/app/api/machine/mpp/orders/route";
import { GET as orderGet } from "@/app/api/machine/mpp/orders/[id]/route";
import { deriveOrderId, validateOrder } from "@/lib/orders";
import { orderDigest } from "@/lib/checkout";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";
import { product } from "@/lib/config";

const VALID_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example";
const UUID = "11111111-1111-4111-8111-111111111111";

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("mpp orders validate", () => {
  it("returns protocol, methods, product_type, and quote", async () => {
    const response = await validatePost(
      post("/api/machine/mpp/orders/validate", {
        request_id: UUID,
        duration_minutes: 60,
        ssh_public_key: VALID_KEY,
      }),
    );
    const body = (await response.json()) as {
      protocol: string;
      methods: string[];
      product_type: string;
      quote: { amount_cents: number };
      request_id: string;
    };

    assert.equal(response.status, 200);
    assert.equal(body.protocol, "mpp");
    assert.deepEqual(body.methods, ["stripe_spt"]);
    assert.equal(body.product_type, "machine_lease");
    assert.equal(body.request_id, UUID);
    assert.equal(typeof body.quote.amount_cents, "number");
  });

  it("requires a UUID request_id", async () => {
    const missing = await validatePost(
      post("/api/machine/mpp/orders/validate", { duration_minutes: 60, ssh_public_key: VALID_KEY }),
    );
    assert.equal(missing.status, 400);

    const notUuid = await validatePost(
      post("/api/machine/mpp/orders/validate", {
        request_id: "ord-123",
        duration_minutes: 60,
        ssh_public_key: VALID_KEY,
      }),
    );
    assert.equal(notUuid.status, 400);
  });

  it("validateOrder is pure — no Stripe config required", () => {
    const result = validateOrder({ request_id: UUID, duration_minutes: 60, ssh_public_key: VALID_KEY });
    assert.equal(result.protocol, "mpp");
    assert.equal(result.request_id, UUID);
  });
});

describe("mpp orders create", () => {
  it("rejects a missing request_id before touching payment", async () => {
    const response = await ordersPost(
      post("/api/machine/mpp/orders", { duration_minutes: 60, ssh_public_key: VALID_KEY }),
    );
    assert.equal(response.status, 400);
  });

  it("reaches payment composition with a valid body (503 when Stripe unconfigured)", async () => {
    // A valid request gets past validation and idempotency, then fails closed at
    // createMppCheckout because no live Stripe credentials are set in tests.
    // Proves the request is well-formed and the challenge path is exercised.
    const response = await ordersPost(
      post("/api/machine/mpp/orders", { request_id: UUID, duration_minutes: 60, ssh_public_key: VALID_KEY }),
    );
    assert.equal(response.status, 503);
  });
});

describe("mpp orders poll", () => {
  it("404s for an unknown order id", async () => {
    const response = await orderGet(new Request("http://localhost:3000/api/machine/mpp/orders/order_unknown"), {
      params: Promise.resolve({ id: "order_unknown" }),
    });
    assert.equal(response.status, 404);
  });
});

describe("order identity and binding", () => {
  it("derives a stable order id from request_id", () => {
    assert.equal(deriveOrderId(UUID), deriveOrderId(UUID));
    assert.notEqual(deriveOrderId(UUID), deriveOrderId("22222222-2222-4222-8222-222222222222"));
    assert.match(deriveOrderId(UUID), /^order_[0-9a-f]{24}$/);
  });

  it("binds the digest to ssh_public_key — same price, different key differs", () => {
    const base = { durationMinutes: 60, sshPublicKey: VALID_KEY, requestId: UUID };
    const other = { durationMinutes: 60, sshPublicKey: `${VALID_KEY}-2`, requestId: UUID };
    assert.notEqual(orderDigest(base), orderDigest(other));
  });

  it("is stable for an identical order so the paid retry reproduces the challenge", () => {
    const order = { durationMinutes: 60, sshPublicKey: VALID_KEY, requestId: UUID };
    assert.equal(orderDigest(order), orderDigest({ ...order }));
  });

  it("parses and requires a UUID request_id on the order path", () => {
    const parsed = parseCreateMachineRequest(
      { request_id: UUID, duration_minutes: 60, ssh_public_key: VALID_KEY },
      product,
      { requireRequestId: true },
    );
    assert.equal(parsed.requestId, UUID);

    assert.throws(
      () =>
        parseCreateMachineRequest(
          { duration_minutes: 60, ssh_public_key: VALID_KEY },
          product,
          { requireRequestId: true },
        ),
      ValidationError,
    );
  });
});
