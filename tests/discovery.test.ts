import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentStorefrontManifest, llmsText, openApiDocument } from "@/lib/discovery";

describe("agent discovery", () => {
  it("publishes concise LLM instructions", () => {
    const text = llmsText();

    assert.match(text, /Agentic Compute Storefront/);
    assert.ok(text.includes("POST /api/checkout"));
    assert.match(text, /HTTP 402/);
    assert.match(text, /Stripe-backed MPP payment credential/);
    assert.match(text, /Stripe Link CLI MPP SPT/);
    assert.match(text, /spend request/i);
    assert.match(text, /mpp decode/);
    assert.match(text, /--test/);
    assert.match(text, /\/api\/checkout\/sandbox/);
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
    assert.deepEqual(manifest.payments.methods, ["stripe-spt"]);
    assert.equal(manifest.payments.sandbox_testing.mode, "stripe_link_cli_test_spt");
    assert.equal(manifest.payment_client_guidance.recommended.id, "stripe-link-cli-mpp-spt");
    assert.ok(manifest.payment_client_guidance.recommended.command_sequence[0].includes("mpp decode"));
    assert.ok(manifest.payment_client_guidance.recommended.command_sequence[2].includes("--line-item"));
    assert.ok(manifest.payment_client_guidance.recommended.command_sequence[3].includes("--spend-request-id"));
    assert.match(manifest.payment_client_guidance.sandbox_testing.summary, /--test/);
    assert.ok(
      manifest.payment_client_guidance.also_supported.some((item) => item.id === "operator-sponsored-sandbox-checkout"),
    );
    assert.ok(manifest.payment_client_guidance.unsupported.some((item) => item.id === "link-cli-virtual-card"));
    assert.equal(manifest.acceptable_use_url, "http://localhost:3000/acceptable-use");
    assert.ok(manifest.checkout_guidance.some((item) => item.includes("HTTP 402")));
    assert.ok(manifest.usage_policy.prohibited_uses.some((item) => item.includes("Spam")));
    assert.equal(manifest.endpoints.checkout.path, "/api/checkout");
    assert.equal(manifest.endpoints.sandbox_checkout.path, "/api/checkout/sandbox");
    assert.equal(manifest.endpoints.read.auth, "Bearer <read_token>");
    assert.equal(manifest.openapi_url, "/openapi.json");
  });

  it("publishes an OpenAPI document for the machine lifecycle", () => {
    const spec = openApiDocument();

    assert.equal(spec.openapi, "3.1.0");
    assert.ok(spec.paths["/api/checkout"]);
    assert.ok(spec.paths["/api/checkout/sandbox"]);
    assert.ok(spec.paths["/api/machines"]);
    assert.ok(spec.paths["/api/machines/{machine_id}"]);
    assert.ok(spec.paths["/api/machines/{machine_id}/extend"]);
    assert.ok(spec.components.securitySchemes.readToken);
    assert.ok(spec.components.schemas.CheckoutMachineResponse);
    assert.ok(spec.components.schemas.MachineWithManagement);
  });
});
