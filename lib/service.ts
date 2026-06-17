import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { loadSettings, type Product, type ProviderName } from "@/lib/config";
import { buildProvider, type ComputeProvider } from "@/lib/providers";
import type {
  CapabilityAction,
  CreateMachineRequest,
  LeaseCapabilityToken,
  MachineLease,
  MachineManagementTokens,
} from "@/lib/models";
import { FileLeaseStore, RedisRestLeaseStore, type LeaseStoreBackend } from "@/lib/store";

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 401 | 403 = 401,
  ) {
    super(message);
  }
}

export type CreatedMachine = {
  lease: MachineLease;
  management: MachineManagementTokens;
};

// A lease still in "provisioning" past this age is treated as stuck (the
// background provisioning task died before it could finish) and is failed by
// the expiry cron so callers stop polling and the slot is freed.
const PROVISION_TIMEOUT_MS = parsePositiveMinutes(process.env.PROVISION_TIMEOUT_MINUTES, 10) * 60_000;

// Terminated/failed leases are kept this long (for status reads / receipts)
// before the expiry cron prunes them from the store.
const PRUNE_RETENTION_MS = parsePositiveMinutes(process.env.PRUNE_RETENTION_MINUTES, 24 * 60) * 60_000;

export class MachineService {
  constructor(
    private readonly store: LeaseStoreBackend,
    private readonly provider: ComputeProvider,
    private readonly product: Product,
    private readonly providerName: ProviderName,
  ) {}

  async createMachine(request: CreateMachineRequest): Promise<CreatedMachine> {
    const now = new Date();
    const lease: MachineLease = {
      id: `machine_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      productId: this.product.id,
      provider: this.providerName,
      providerServerId: null,
      providerSshKeyId: null,
      providerFirewallId: null,
      status: "provisioning",
      sshPublicKey: request.sshPublicKey,
      host: null,
      username: this.product.username,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + request.durationMinutes * 60_000).toISOString(),
      terminatedAt: null,
      failureReason: null,
    };

    await this.store.create(lease);
    const management = await this.createCapabilities(lease);
    // Provisioning (especially against a real provider) can take tens of
    // seconds, which would blow the serverless request budget and — on the
    // paid path — leave the buyer charged with no response. The lease and its
    // management tokens are persisted here and returned immediately in the
    // "provisioning" state; the caller triggers `provisionMachine` in the
    // background (e.g. via `after()`) and polls with the read token.
    return { lease, management };
  }

  // Drives a freshly created lease to "active" (or "failed"). Safe to run in a
  // background task after the create response has been sent.
  async provisionMachine(id: string): Promise<void> {
    await this.provision(id);
  }

  async getMachine(id: string, bearerToken: string): Promise<MachineLease | null> {
    // Authorize before any existence check so a caller without a valid
    // capability token can't distinguish real machine IDs (401/403) from
    // non-existent ones (404).
    await this.authorize(id, bearerToken, "read");
    return this.store.get(id);
  }

  async extendMachine(id: string, bearerToken: string, additionalMinutes: number): Promise<MachineLease | null> {
    await this.authorize(id, bearerToken, "extend");
    const lease = await this.store.get(id);
    if (!lease) {
      return null;
    }
    if (lease.status !== "active" && lease.status !== "provisioning") {
      throw new Error(`Cannot extend a machine with status ${lease.status}.`);
    }

    const createdAt = Date.parse(lease.createdAt);
    const currentExpiry = Date.parse(lease.expiresAt);
    const requestedExpiry = currentExpiry + additionalMinutes * 60_000;
    const maxExpiry = createdAt + this.product.maxDurationMinutes * 60_000;
    if (requestedExpiry > maxExpiry) {
      throw new Error(`Lease cannot exceed ${this.product.maxDurationMinutes} total minutes.`);
    }

    await this.store.extendLease(id, new Date(requestedExpiry).toISOString());
    return this.store.get(id);
  }

  async terminateMachine(id: string, bearerToken: string): Promise<MachineLease | null> {
    // A capability token is ALWAYS required on the public path. (A prior
    // version skipped auth when the token was an empty string, which let an
    // unauthenticated DELETE terminate any machine by id.) Authorize before the
    // existence check so missing ids don't leak via 404-vs-401.
    await this.authorize(id, bearerToken, "terminate");
    return this.terminateLease(id);
  }

  async expireDueMachines(): Promise<number> {
    const expired = await this.store.expiredLeases();
    for (const lease of expired) {
      await this.terminateLease(lease.id);
    }
    return expired.length;
  }

  // Internal, unauthenticated termination used only by trusted lifecycle paths
  // (expiry cron, post-payment cleanup). Never call this directly from a route.
  private async terminateLease(id: string): Promise<MachineLease | null> {
    const existingLease = await this.store.get(id);
    if (!existingLease) {
      return null;
    }
    const lease = await this.store.markTerminating(id);
    if (!lease) {
      return null;
    }
    if (lease.status === "terminated") {
      return this.store.get(id);
    }

    try {
      await this.provider.terminate(lease);
      await this.store.markTerminated(id);
    } catch (error) {
      // Keep the provider detail in server logs; expose only a generic reason.
      console.error(`Provider termination failed for ${id}: ${errorMessage(error)}`);
      await this.store.markFailed(id, "Termination failed.");
    }

    return this.store.get(id);
  }

  // Removes terminated/failed leases (and their capability tokens) whose
  // terminal timestamp is older than the retention window, bounding the growth
  // of the lease store. Called from the expiry cron.
  async pruneRetiredMachines(now = new Date()): Promise<number> {
    return this.store.pruneRetired(now, PRUNE_RETENTION_MS);
  }

  // Safety net for the async provisioning path: if a background provisioning
  // task dies before reaching "active", the lease would otherwise poll forever.
  // The expiry cron calls this to fail leases stuck in "provisioning" and to
  // best-effort release any provider resources they may have recorded.
  async reapStuckProvisioning(now = new Date()): Promise<number> {
    const cutoff = now.getTime() - PROVISION_TIMEOUT_MS;
    const stuck = (await this.store.provisioningLeases()).filter(
      (lease) => Date.parse(lease.createdAt) <= cutoff,
    );
    for (const lease of stuck) {
      try {
        await this.provider.terminate(lease);
      } catch {
        // Best effort: still mark the lease failed below.
      }
      await this.store.markFailed(lease.id, "Provisioning did not complete in time.");
    }
    return stuck.length;
  }

  private async provision(id: string): Promise<void> {
    const lease = await this.store.get(id);
    if (!lease) {
      return;
    }

    try {
      const machine = await this.provider.provision(lease);
      const freshLease = await this.store.get(id);
      if (freshLease?.status === "terminating") {
        await this.provider.terminate({
          ...freshLease,
          providerServerId: machine.providerServerId,
          providerSshKeyId: machine.providerSshKeyId ?? null,
          providerFirewallId: machine.providerFirewallId ?? null,
          host: machine.host,
          username: machine.username,
        });
        await this.store.markTerminated(id);
        return;
      }
      await this.store.markActive(
        id,
        machine.providerServerId,
        machine.host,
        machine.username,
        machine.providerSshKeyId,
        machine.providerFirewallId,
      );
    } catch (error) {
      // Keep the provider detail in server logs; expose only a generic reason
      // so raw upstream API error bodies aren't surfaced to the lease holder.
      console.error(`Provisioning failed for ${id}: ${errorMessage(error)}`);
      await this.store.markFailed(id, "Provisioning failed.");
    }
  }

  private async createCapabilities(lease: MachineLease): Promise<MachineManagementTokens> {
    const readToken = generateToken("mt_read");
    const extendToken = generateToken("mt_extend");
    const terminateToken = generateToken("mt_term");
    const now = new Date().toISOString();
    const tokenExpiresAt = lease.expiresAt;
    const records: LeaseCapabilityToken[] = [
      capabilityRecord(lease.id, readToken, ["read"], now, tokenExpiresAt),
      capabilityRecord(lease.id, extendToken, ["extend"], now, tokenExpiresAt),
      capabilityRecord(lease.id, terminateToken, ["terminate"], now, tokenExpiresAt),
    ];

    await this.store.createCapabilityTokens(records);

    return {
      read_token: readToken,
      extend_token: extendToken,
      terminate_token: terminateToken,
    };
  }

  private async authorize(machineId: string, bearerToken: string, action: CapabilityAction): Promise<void> {
    const token = bearerToken.trim();
    if (!token) {
      throw new AuthorizationError("Missing bearer token.");
    }

    const tokenRecord = await this.store.getCapabilityTokenByHash(hashToken(token));
    if (!tokenRecord || tokenRecord.revokedAt) {
      throw new AuthorizationError("Invalid bearer token.");
    }
    if (!constantTimeEqual(tokenRecord.machineId, machineId)) {
      throw new AuthorizationError("Token is not valid for this machine.", 403);
    }
    if (!tokenRecord.actions.includes(action)) {
      throw new AuthorizationError("Token is not authorized for this action.", 403);
    }
    if (Date.parse(tokenRecord.expiresAt) < Date.now()) {
      throw new AuthorizationError("Bearer token has expired.");
    }
  }
}

export function createMachineService() {
  const settings = loadSettings();
  return new MachineService(
    settings.leaseStore === "redis-rest"
      ? new RedisRestLeaseStore(settings.redisRestUrl!, settings.redisRestToken!, settings.redisRestKey)
      : new FileLeaseStore(settings.dataPath),
    buildProvider(settings),
    settings.product,
    settings.provider,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveMinutes(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function capabilityRecord(
  machineId: string,
  rawToken: string,
  actions: CapabilityAction[],
  createdAt: string,
  expiresAt: string,
): LeaseCapabilityToken {
  return {
    id: `cap_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    machineId,
    tokenHash: hashToken(rawToken),
    actions,
    createdAt,
    expiresAt,
    revokedAt: null,
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
