import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMppCheckout } from "@/lib/checkout";
import { loadSettings } from "@/lib/config";

describe("checkout configuration", () => {
  it("blocks Stripe test-mode payments", () => {
    const original = snapshotEnv([
      "PROVIDER",
      "MPP_SECRET_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_PROFILE_ID",
    ]);

    process.env.PROVIDER = "hetzner";
    process.env.MPP_SECRET_KEY = "test-mpp-secret";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PROFILE_ID = "profile_test_123";

    try {
      assert.throws(() => createMppCheckout(), /Production checkout requires live Stripe credentials/);
    } finally {
      restoreEnv(original);
    }
  });

  it("requires durable storage for real providers in production", () => {
    const original = snapshotEnv(["NODE_ENV", "PROVIDER", "LEASE_STORE"]);

    Object.assign(process.env, { NODE_ENV: "production" });
    process.env.PROVIDER = "hetzner";
    process.env.LEASE_STORE = "file";

    try {
      assert.throws(() => loadSettings(), /LEASE_STORE=redis-rest/);
    } finally {
      restoreEnv(original);
    }
  });
});

function snapshotEnv(names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
