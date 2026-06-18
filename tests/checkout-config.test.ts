import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertOperatorSponsoredSandboxCheckoutAllowed,
  CheckoutConfigurationError,
  createMppCheckout,
} from "@/lib/checkout";
import { loadSettings } from "@/lib/config";

describe("checkout configuration", () => {
  it("blocks Stripe test-mode payments from creating real provider resources by default", () => {
    const original = snapshotEnv([
      "PROVIDER",
      "MPP_SECRET_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_PROFILE_ID",
      "ALLOW_TEST_PAYMENTS_WITH_REAL_PROVIDER",
    ]);

    process.env.PROVIDER = "hetzner";
    process.env.MPP_SECRET_KEY = "test-mpp-secret";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PROFILE_ID = "profile_test_123";
    delete process.env.ALLOW_TEST_PAYMENTS_WITH_REAL_PROVIDER;

    try {
      assert.throws(() => createMppCheckout(), CheckoutConfigurationError);
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

  it("guards operator-sponsored sandbox checkout for real providers", () => {
    const original = snapshotEnv([
      "PROVIDER",
      "STRIPE_SECRET_KEY",
      "STRIPE_PROFILE_ID",
      "ALLOW_TEST_PAYMENTS_WITH_REAL_PROVIDER",
    ]);

    process.env.PROVIDER = "hetzner";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PROFILE_ID = "profile_test_123";
    delete process.env.ALLOW_TEST_PAYMENTS_WITH_REAL_PROVIDER;

    try {
      assert.throws(() => assertOperatorSponsoredSandboxCheckoutAllowed(), CheckoutConfigurationError);

      process.env.ALLOW_TEST_PAYMENTS_WITH_REAL_PROVIDER = "true";
      assert.doesNotThrow(() => assertOperatorSponsoredSandboxCheckoutAllowed());
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
