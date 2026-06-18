import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentStorefrontManifest, llmsText, openApiDocument } from "@/lib/discovery";

describe("agent discovery", () => {
  it("publishes concise LLM instructions", () => {
    const text = llmsText();

    assert.match(text, /Agentic Compute Storefront/);
    assert.ok(text.includes("POST /api/machine/mpp/orders"));
    assert.match(text, /HTTP 402/);
    assert.match(text, /Stripe-backed MPP payment credential/);
    assert.match(text, /Stripe Link CLI MPP SPT/);
    assert.match(text, /spend request/i);
    assert.match(text, /mpp decode/);
    assert.match(text, /live Stripe SPT/);
    assert.doesNotMatch(text, /\/api\/checkout\/sandbox/);
    assert.match(text, /Do not use Link CLI virtual cards/);
    assert.match(text, /Acceptable use/);
    assert.match(text, /Do not use machines for: Spam/);
    assert.match(text, /read_token/);
    assert.match(text, /terminate_token/);
    assert.match(text, /Terminate the machine when finished/);
  });

  it("publishes a structured agent storefront manifest", () => {
    const manifest = agentStorefrontManifest();

    assert.equal(manifest.products[0].id, "bare-linux-machine");
    assert.equal(manifest.auth.type, "lease_capability_tokens");
    assert.equal(manifest.payments.protocol, "mpp");
    assert.equal(manifest.payments.processor, "stripe");
    assert.deepEqual(manifest.payments.methods, ["stripe_spt"]);
    assert.equal(manifest.payments.environment, "production");
    assert.equal(manifest.payment_client_guidance.recommended.id, "stripe-link-cli-mpp-spt");
    assert.ok(manifest.payment_client_guidance.recommended.command_sequence[0].includes("mpp decode"));
    assert.ok(manifest.payment_client_guidance.recommended.command_sequence[2].includes("--line-item"));
    assert.ok(manifest.payment_client_guidance.recommended.command_sequence[3].includes("--spend-request-id"));
    assert.ok(
      manifest.payment_client_guidance.also_supported.some((item) => item.id === "generic-mpp-stripe-spt-client"),
    );
    assert.ok(manifest.payment_client_guidance.unsupported.some((item) => item.id === "link-cli-virtual-card"));
    assert.equal(manifest.acceptable_use_url, "http://localhost:3000/acceptable-use");
    assert.ok(manifest.checkout_guidance.some((item) => item.includes("HTTP 402")));
    assert.ok(manifest.usage_policy.prohibited_uses.some((item) => item.includes("Spam")));
    assert.equal(manifest.endpoints.checkout.path, "/api/machine/mpp/orders");
    assert.equal(manifest.endpoints.validate.path, "/api/machine/mpp/orders/validate");
    assert.equal(manifest.endpoints.order_status.path, "/api/machine/mpp/orders/{order_id}");
    assert.equal(manifest.payments.idempotency_key, "request_id");
    assert.equal(manifest.endpoints.read.auth, "Bearer <read_token>");
    assert.equal(manifest.openapi_url, "/openapi.json");
  });

  it("publishes an OpenAPI document for the machine lifecycle", () => {
    const spec = openApiDocument();

    assert.equal(spec.openapi, "3.1.0");
    assert.ok(spec.paths["/api/machine/mpp/orders"]);
    assert.ok(spec.paths["/api/machine/mpp/orders/validate"]);
    assert.ok(spec.paths["/api/machine/mpp/orders/{order_id}"]);
    assert.equal(Reflect.has(spec.paths, "/api/checkout"), false);
    assert.ok(spec.paths["/api/machines"]);
    assert.ok(spec.paths["/api/machines/{machine_id}"]);
    assert.ok(spec.paths["/api/machines/{machine_id}/extend"]);
    assert.ok(spec.components.securitySchemes.readToken);
    assert.ok(spec.components.schemas.MppOrder);
    assert.ok(spec.components.schemas.ValidateOrderResponse);
    assert.ok(spec.components.schemas.MachineWithManagement);
  });
});
