import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { product } from "@/lib/config";
import type { MachineLease } from "@/lib/models";
import { HetznerProvider } from "@/lib/providers";

const originalFetch = globalThis.fetch;

describe("Hetzner provider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses hostname-safe names for server resources", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      requests.push({ path: url.pathname, body });

      if (url.pathname === "/v1/ssh_keys") {
        return jsonResponse({ ssh_key: { id: 101 } });
      }
      if (url.pathname === "/v1/firewalls") {
        return jsonResponse({ firewall: { id: 202 } });
      }
      if (url.pathname === "/v1/servers") {
        return jsonResponse({ server: { id: 303, public_net: { ipv4: { ip: "192.0.2.42" } } } });
      }
      throw new Error(`Unexpected Hetzner request: ${url.pathname}`);
    }) as typeof fetch;

    await new HetznerProvider("test-token", product).provision(lease("machine_e2b553d950f84ff0"));

    const serverRequest = requests.find((request) => request.path === "/v1/servers");
    assert.equal(serverRequest?.body?.name, "lease-machine-e2b553d950f84ff0");
  });
});

function lease(id: string): MachineLease {
  const now = new Date().toISOString();
  return {
    id,
    productId: product.id,
    provider: "hetzner",
    providerServerId: null,
    providerSshKeyId: null,
    providerFirewallId: null,
    status: "provisioning",
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example",
    host: null,
    username: product.username,
    createdAt: now,
    expiresAt: now,
    terminatedAt: null,
    failureReason: null,
    orderId: null,
    requestId: null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
