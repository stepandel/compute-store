import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POST } from "@/app/api/machines/route";

describe("machine create route", () => {
  it("rejects unpaid creates when the provider is not dry-run", async () => {
    const originalProvider = process.env.PROVIDER;
    const originalAllow = process.env.ALLOW_UNPAID_MACHINE_CREATE;
    process.env.PROVIDER = "hetzner";
    delete process.env.ALLOW_UNPAID_MACHINE_CREATE;

    try {
      const response = await POST(
        new Request("http://localhost:3000/api/machines", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            duration_minutes: 60,
            ssh_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example",
          }),
        }),
      );
      const body = (await response.json()) as { error?: string };

      assert.equal(response.status, 403);
      assert.match(body.error ?? "", /Use POST \/api\/checkout/);
    } finally {
      restoreEnv("PROVIDER", originalProvider);
      restoreEnv("ALLOW_UNPAID_MACHINE_CREATE", originalAllow);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
