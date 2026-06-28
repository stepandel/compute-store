import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPublicMachine } from "@/lib/models";
import { createMachineService } from "@/lib/service";

const VALID_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example";

// Full GPU lifecycle through the real createMachineService wiring in dry-run
// mode: create -> provision -> read active -> extend -> terminate. This is the
// same createMachine/provision path the paid MPP order route drives after
// payment, exercised here without Stripe/MPP credentials.
//
// The lease is created+provisioned on a GPU service, but read/extended/
// terminated on the DEFAULT (CPU) service — proving the per-lease provider
// resolver manages a GPU lease correctly even on a service built for another
// product, which is exactly what the lifecycle routes (terminate, expiry) do.
describe("gpu-h100-machine end-to-end (dry-run)", () => {
  let tempDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gpu-e2e-"));
    for (const name of ["DATA_PATH", "PROVIDER", "LEASE_STORE"]) {
      saved[name] = process.env[name];
    }
    process.env.DATA_PATH = join(tempDir, "machines.json");
    process.env.PROVIDER = "dry-run";
    process.env.LEASE_STORE = "file";
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates, provisions, reads, extends, and terminates a GPU lease", async () => {
    const gpuService = createMachineService("gpu-h100-machine");

    // 1. Create -> provisioning lease on the GPU product with management tokens.
    const { lease, management } = await gpuService.createMachine({
      productId: "gpu-h100-machine",
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });
    assert.equal(lease.productId, "gpu-h100-machine");
    assert.equal(lease.provider, "dry-run");
    assert.equal(lease.status, "provisioning");
    assert.equal(lease.username, "root");
    assert.match(management.read_token, /^mt_read_/);

    // 2. Provision (the background task the route runs via after()).
    await gpuService.provisionMachine(lease.id);

    // 3-5. Read, extend, terminate on the DEFAULT service — the per-lease
    //      resolver rebuilds the GPU lease's backend for each operation.
    const cpuService = createMachineService();

    const active = await cpuService.getMachine(lease.id, management.read_token);
    assert.ok(active);
    assert.equal(active.status, "active");
    assert.equal(active.productId, "gpu-h100-machine");
    assert.equal(active.host, "203.0.113.10");
    assert.equal(toPublicMachine(active).ssh_command, "ssh root@203.0.113.10");

    const extended = await cpuService.extendMachine(lease.id, management.extend_token, 15);
    assert.ok(extended);
    assert.equal(Date.parse(extended.expiresAt), Date.parse(lease.expiresAt) + 15 * 60_000);

    const terminated = await cpuService.terminateMachine(lease.id, management.terminate_token);
    assert.ok(terminated);
    assert.equal(terminated.status, "terminated");
    assert.equal(terminated.productId, "gpu-h100-machine");
    assert.ok(terminated.terminatedAt);
  });
});
