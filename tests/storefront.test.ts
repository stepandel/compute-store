import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { product } from "@/lib/config";
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

  it("validates the single-product request", () => {
    const request = parseCreateMachineRequest(
      {
        duration_minutes: 60,
        ssh_public_key: VALID_KEY,
      },
      product,
    );

    assert.equal(request.durationMinutes, 60);
    assert.equal(request.sshPublicKey, VALID_KEY);
  });

  it("rejects durations outside policy", () => {
    assert.throws(
      () =>
        parseCreateMachineRequest(
          {
            duration_minutes: 1,
            ssh_public_key: VALID_KEY,
          },
          product,
        ),
      ValidationError,
    );
  });

  it("creates a machine that becomes active", async () => {
    const created = await service.createMachine({
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });

    const { lease, management } = created;
    assert.equal(lease.status, "provisioning");
    assert.match(management.read_token, /^mt_read_/);
    assert.match(management.extend_token, /^mt_extend_/);
    assert.match(management.terminate_token, /^mt_term_/);

    const active = await waitForMachine(lease.id, management.read_token, (machine) => machine.status === "active");
    assert.equal(active.status, "active");
    assert.equal(active.host, "203.0.113.10");
    assert.equal(toPublicMachine(active).ssh_command, "ssh root@203.0.113.10");
  });

  it("requires the right capability token to read a machine", async () => {
    const { lease, management } = await service.createMachine({
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });

    await assert.rejects(() => service.getMachine(lease.id, ""), AuthorizationError);
    await assert.rejects(() => service.getMachine(lease.id, management.terminate_token), AuthorizationError);

    const readable = await service.getMachine(lease.id, management.read_token);
    assert.ok(readable);
    assert.equal(readable.id, lease.id);
  });

  it("returns missing machines before validating capabilities", async () => {
    const missingId = "machine_0000000000000000";

    const missingRead = await service.getMachine(missingId, "");
    const missingTerminate = await service.terminateMachine(missingId, "not-a-real-token");
    const missingExtend = await service.extendMachine(missingId, "not-a-real-token", 15);

    assert.equal(missingRead, null);
    assert.equal(missingTerminate, null);
    assert.equal(missingExtend, null);
  });

  it("terminates a machine", async () => {
    const { lease, management } = await service.createMachine({
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });
    await waitForMachine(lease.id, management.read_token, (machine) => machine.status === "active");

    await assert.rejects(() => service.terminateMachine(lease.id, management.read_token), AuthorizationError);
    const terminated = await service.terminateMachine(lease.id, management.terminate_token);

    assert.ok(terminated);
    assert.equal(terminated.status, "terminated");
    assert.ok(terminated.terminatedAt);
  });

  it("extends a machine with the extend capability token", async () => {
    const { lease, management } = await service.createMachine({
      durationMinutes: 60,
      sshPublicKey: VALID_KEY,
    });
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
      status: "active",
      sshPublicKey: VALID_KEY,
      host: "203.0.113.10",
      username: "root",
      createdAt: new Date(now.getTime() - 7_200_000).toISOString(),
      expiresAt: new Date(now.getTime() - 3_600_000).toISOString(),
      terminatedAt: null,
      failureReason: null,
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
