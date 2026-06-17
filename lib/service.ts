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

export class MachineService {
  constructor(
    private readonly store: LeaseStoreBackend,
    private readonly provider: ComputeProvider,
    private readonly product: Product,
    private readonly providerName: ProviderName,
  ) {}

  async createMachine(request: CreateMachineRequest): Promise<CreatedMachine> {
    await this.expireDueMachines();

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
    await this.provision(lease.id);
    return { lease: (await this.store.get(lease.id)) ?? lease, management };
  }

  async getMachine(id: string, bearerToken: string): Promise<MachineLease | null> {
    await this.expireDueMachines();
    const lease = await this.store.get(id);
    if (!lease) {
      return null;
    }
    await this.authorize(id, bearerToken, "read");
    return lease;
  }

  async extendMachine(id: string, bearerToken: string, additionalMinutes: number): Promise<MachineLease | null> {
    await this.expireDueMachines();
    const lease = await this.store.get(id);
    if (!lease) {
      return null;
    }
    await this.authorize(id, bearerToken, "extend");
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

  async terminateMachine(id: string, bearerToken?: string): Promise<MachineLease | null> {
    const existingLease = await this.store.get(id);
    if (!existingLease) {
      return null;
    }
    if (bearerToken) {
      await this.authorize(id, bearerToken, "terminate");
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
      await this.store.markFailed(id, errorMessage(error));
    }

    return this.store.get(id);
  }

  async expireDueMachines(): Promise<number> {
    const expired = await this.store.expiredLeases();
    for (const lease of expired) {
      await this.terminateMachine(lease.id);
    }
    return expired.length;
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
      await this.store.markFailed(id, errorMessage(error));
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
