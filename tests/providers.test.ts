import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProduct, product } from "@/lib/config";
import type { MachineLease } from "@/lib/models";
import { HetznerProvider, RunpodProvider } from "@/lib/providers";

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

describe("RunPod provider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a pod with the SSH key and resolves the forwarded SSH endpoint", async () => {
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
    const gpuProduct = getProduct("gpu-h100-machine");

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      requests.push({ method, path: url.pathname, body });

      if (url.pathname === "/v1/pods" && method === "POST") {
        return jsonResponse({ id: "pod_123" });
      }
      if (url.pathname === "/v1/pods/pod_123" && method === "GET") {
        return jsonResponse({ publicIp: "203.0.113.55", portMappings: { "22": 40123 } });
      }
      throw new Error(`Unexpected RunPod request: ${method} ${url.pathname}`);
    }) as typeof fetch;

    const gpuLease: MachineLease = { ...lease("machine_gpu0000000000a1"), productId: "gpu-h100-machine", provider: "runpod" };
    const provisioned = await new RunpodProvider("rp-token", gpuProduct).provision(gpuLease);

    assert.equal(provisioned.providerServerId, "pod_123");
    assert.equal(provisioned.host, "203.0.113.55");
    assert.equal(provisioned.sshPort, 40123);

    const createRequest = requests.find((request) => request.path === "/v1/pods");
    assert.equal((createRequest?.body?.env as Record<string, string>).PUBLIC_KEY, gpuLease.sshPublicKey);
    assert.deepEqual(createRequest?.body?.gpuTypeIds, [gpuProduct.serverType]);
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
    sshPort: null,
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
