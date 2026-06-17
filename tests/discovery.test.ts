import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentStorefrontManifest, llmsText, openApiDocument } from "@/lib/discovery";

describe("agent discovery", () => {
  it("publishes concise LLM instructions", () => {
    const text = llmsText();

    assert.match(text, /Agentic Compute Storefront/);
    assert.ok(text.includes("POST /api/machines"));
    assert.match(text, /read_token/);
    assert.match(text, /terminate_token/);
    assert.match(text, /Terminate the machine when finished/);
  });

  it("publishes a structured agent storefront manifest", () => {
    const manifest = agentStorefrontManifest();

    assert.equal(manifest.products[0].id, "bare-linux-machine");
    assert.equal(manifest.auth.type, "lease_capability_tokens");
    assert.equal(manifest.endpoints.create.path, "/api/machines");
    assert.equal(manifest.endpoints.read.auth, "Bearer <read_token>");
    assert.equal(manifest.openapi_url, "/openapi.json");
  });

  it("publishes an OpenAPI document for the machine lifecycle", () => {
    const spec = openApiDocument();

    assert.equal(spec.openapi, "3.1.0");
    assert.ok(spec.paths["/api/machines"]);
    assert.ok(spec.paths["/api/machines/{machine_id}"]);
    assert.ok(spec.paths["/api/machines/{machine_id}/extend"]);
    assert.ok(spec.components.securitySchemes.readToken);
    assert.ok(spec.components.schemas.MachineWithManagement);
  });
});
