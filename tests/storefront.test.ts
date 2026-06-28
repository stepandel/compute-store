import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { product } from "@/lib/config";
import { quoteCheckout } from "@/lib/checkout";
import type { MachineLease } from "@/lib/models";
import { DryRunProvider } from "@/lib/providers";
import { AuthorizationError, MachineService } from "@/lib/service";
import { LeaseStore } from "@/lib/store";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";
import { toPublicMachine } from "@/lib/models";

const VALID_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example";

describe("compute storefront", () => {
  let tempDir: string;
  let service: MachineService;
  let store: LeaseStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "storefront-test-"));
    store = new LeaseStore(join(tempDir, "machines.json"));
    service = new MachineService(store, new DryRunProvider(), product, "dry-run");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("validates a product request", () => {
    const request = parseCreateMachineRequest({
      product_id: product.id,
      duration_minutes: 60,
      ssh_public_key: VALID_KEY,
    });

    assert.equal(request.productId, product.id);
    assert.equal(request.durationMinutes, 60);
    assert.equal(request.sshPublicKey, VALID_KEY);
  });

  it("requires a known product_id", () => {
    assert.throws(
      () => parseCreateMachineRequest({ duration_minutes: 60, ssh_public_key: VALID_KEY }),
      ValidationError,
    );
    assert.throws(
      () => parseCreateMachineRequest({ product_id: "nope", duration_minutes: 60, ssh_public_key: VALID_KEY }),
      ValidationError,
    );
  });

  it("prices checkout by requested lease duration", () => {
    const originalBaseFee = process.env.CHECKOUT_BASE_FEE_CENTS;
    const originalMinutePrice = process.env.PRICE_CENTS_PER_MINUTE;
    delete process.env.CHECKOUT_BASE_FEE_CENTS;
    delete process.env.PRICE_CENTS_PER_MINUTE;

    try {
      const quote = quoteCheckout({
        productId: "bare-linux-machine",
        durationMinutes: 60,
        sshPublicKey: VALID_KEY,
      });

      assert.equal(quote.currency, "usd");
      assert.equal(quote.product_id, "bare-linux-machine");
      assert.equal(quote.base_fee_cents, 99);
      assert.equal(quote.unit_price_cents_per_minute, 5);
      assert.equal(quote.amount_cents, 399);
      assert.equal(quote.amount, "3.99");
    } finally {
      restoreEnv("CHECKOUT_BASE_FEE_CENTS", originalBaseFee);
      restoreEnv("PRICE_CENTS_PER_MINUTE", originalMinutePrice);
    }
  });

  it("prices the GPU product higher than the CPU product per minute", () => {
    const originalGpuBase = process.env.GPU_CHECKOUT_BASE_FEE_CENTS;
    const originalGpuMinute = process.env.GPU_PRICE_CENTS_PER_MINUTE;
    delete process.env.GPU_CHECKOUT_BASE_FEE_CENTS;
    delete process.env.GPU_PRICE_CENTS_PER_MINUTE;

    try {
      const gpu = quoteCheckout({
        productId: "gpu-h100-machine",
        durationMinutes: 60,
        sshPublicKey: VALID_KEY,
      });
      const cpu = quoteCheckout({
        productId: "bare-linux-machine",
        durationMinutes: 60,
        sshPublicKey: VALID_KEY,
      });

      assert.equal(gpu.product_id, "gpu-h100-machine");
      assert.equal(gpu.base_fee_cents, 199);
      assert.equal(gpu.unit_price_cents_per_minute, 9);
      assert.equal(gpu.amount_cents, 199 + 60 * 9);
      assert.ok(gpu.unit_price_cents_per_minute > cpu.unit_price_cents_per_minute);
    } finally {
      restoreEnv("GPU_CHECKOUT_BASE_FEE_CENTS", originalGpuBase);
      restoreEnv("GPU_PRICE_CENTS_PER_MINUTE", originalGpuMinute);
    }
  });

  it("rejects oversized SSH public keys", () => {
    assert.throws(
      () =>
        parseCreateMachineRequest({
          product_id: product.id,
          duration_minutes: 60,
          ssh_public_key: `ssh-ed25519 ${"A".repeat(9000)}`,
        }),
      ValidationError,
    );
  });

  it("rejects durations outside policy", () => {
    assert.throws(
      () =>
        parseCreateMachineRequest({
          product_id: product.id,
          duration_minutes: 1,
          ssh_public_key: VALID_KEY,
        }),
      ValidationError,
    );
  });

  it("returns a provisioning lease with tokens before provisioning runs", async () => {
    const { lease, management } = await service.createMachine({
      productId: product.id,
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });

    // Tokens are issued synchronously so a serverless timeout during background
    // provisioning never leaves the buyer charged without management access.
    assert.equal(lease.status, "provisioning");
    assert.equal(lease.host, null);
    assert.match(management.read_token, /^mt_read_/);
    assert.match(management.extend_token, /^mt_extend_/);
    assert.match(management.terminate_token, /^mt_term_/);
  });

  it("creates a machine that becomes active once provisioned", async () => {
    const { lease, management } = await service.createMachine({
      productId: product.id,
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });

    await service.provisionMachine(lease.id);

    const active = await service.getMachine(lease.id, management.read_token);
    assert.ok(active);
    assert.equal(active.status, "active");
    assert.equal(active.host, "203.0.113.10");
    assert.equal(toPublicMachine(active).ssh_command, "ssh root@203.0.113.10");
  });

  it("fails leases stuck in provisioning past the timeout", async () => {
    const { lease, management } = await service.createMachine({
      productId: product.id,
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });

    // Provisioning never ran; reap it as though the cron found it stale.
    const reaped = await service.reapStuckProvisioning(new Date(Date.now() + 60 * 60_000));
    assert.equal(reaped, 1);

    const failed = await service.getMachine(lease.id, management.read_token);
    assert.ok(failed);
    assert.equal(failed.status, "failed");
    assert.match(failed.failureReason ?? "", /did not complete/);
  });

  it("requires the right capability token to read a machine", async () => {
    const { lease, management } = await service.createMachine({
      productId: product.id,
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });

    await assert.rejects(() => service.getMachine(lease.id, ""), AuthorizationError);
    await assert.rejects(() => service.getMachine(lease.id, management.terminate_token), AuthorizationError);

    const readable = await service.getMachine(lease.id, management.read_token);
    assert.ok(readable);
    assert.equal(readable.id, lease.id);
  });

  it("rejects management of any id without a valid capability token", async () => {
    const missingId = "machine_0000000000000000";

    // Authorize-first: a caller without a valid token can't tell a real id from
    // a missing one — every path rejects rather than leaking 404-vs-401.
    await assert.rejects(() => service.getMachine(missingId, ""), AuthorizationError);
    await assert.rejects(() => service.terminateMachine(missingId, "not-a-real-token"), AuthorizationError);
    await assert.rejects(() => service.extendMachine(missingId, "not-a-real-token", 15), AuthorizationError);
  });

  it("never terminates a machine without a token (no empty-token bypass)", async () => {
    const { lease, management } = await service.createMachine({
      productId: product.id,
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });
    await service.provisionMachine(lease.id);

    // An empty bearer token must NOT skip authorization.
    await assert.rejects(() => service.terminateMachine(lease.id, ""), AuthorizationError);

    const stillThere = await service.getMachine(lease.id, management.read_token);
    assert.ok(stillThere);
    assert.notEqual(stillThere.status, "terminated");
  });

  it("prunes retired leases and their tokens after the retention window", async () => {
    const { lease, management } = await service.createMachine({
      productId: product.id,
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });
    await service.provisionMachine(lease.id);
    await service.terminateMachine(lease.id, management.terminate_token);

    // Pretend the retention window has fully elapsed.
    const removed = await service.pruneRetiredMachines(new Date(Date.now() + 48 * 60 * 60_000));
    assert.equal(removed, 1);

    assert.equal(await store.get(lease.id), null);
    await assert.rejects(() => service.getMachine(lease.id, management.read_token), AuthorizationError);
  });

  it("terminates a machine", async () => {
    const { lease, management } = await service.createMachine({
      productId: product.id,
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });
    await service.provisionMachine(lease.id);
    await waitForMachine(lease.id, management.read_token, (machine) => machine.status === "active");

    await assert.rejects(() => service.terminateMachine(lease.id, management.read_token), AuthorizationError);
    const terminated = await service.terminateMachine(lease.id, management.terminate_token);

    assert.ok(terminated);
    assert.equal(terminated.status, "terminated");
    assert.ok(terminated.terminatedAt);
  });

  it("extends a machine with the extend capability token", async () => {
    const { lease, management } = await service.createMachine({
      productId: product.id,
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });
    await service.provisionMachine(lease.id);
    await waitForMachine(lease.id, management.read_token, (machine) => machine.status === "active");

    await assert.rejects(() => service.extendMachine(lease.id, management.read_token, 15), AuthorizationError);
    const extended = await service.extendMachine(lease.id, management.extend_token, 15);

    assert.ok(extended);
    assert.equal(Date.parse(extended.expiresAt), Date.parse(lease.expiresAt) + 15 * 60_000);
  });

  it("expires due machines without a resident worker", async () => {
    const now = new Date();
    const lease: MachineLease = {
      id: "machine_expired",
      productId: product.id,
      provider: "dry-run",
      providerServerId: "dryrun-machine_expired",
      providerSshKeyId: null,
      providerFirewallId: null,
      status: "active",
      sshPublicKey: VALID_KEY,
      host: "203.0.113.10",
      sshPort: null,
      username: "root",
      createdAt: new Date(now.getTime() - 7_200_000).toISOString(),
      expiresAt: new Date(now.getTime() - 3_600_000).toISOString(),
      terminatedAt: null,
      failureReason: null,
      orderId: null,
      requestId: null,
    };
    await store.create(lease);

    const count = await service.expireDueMachines();
    const stored = await store.get(lease.id);

    assert.equal(count, 1);
    assert.ok(stored);
    assert.equal(stored.status, "terminated");
  });

  async function waitForMachine(
    id: string,
    readToken: string,
    predicate: (lease: MachineLease) => boolean,
  ): Promise<MachineLease> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const lease = await service.getMachine(id, readToken);
      if (lease && predicate(lease)) {
        return lease;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const lease = await service.getMachine(id, readToken);
    assert.fail(`Machine ${id} did not reach expected state. Last state: ${lease?.status ?? "missing"}`);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
