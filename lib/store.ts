import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LeaseCapabilityToken, MachineLease, MachineStatus } from "@/lib/models";

type StoreFile = {
  machines: MachineLease[];
  capabilityTokens: LeaseCapabilityToken[];
};

export interface LeaseStoreBackend {
  create(lease: MachineLease): Promise<void>;
  createCapabilityTokens(tokens: LeaseCapabilityToken[]): Promise<void>;
  getCapabilityTokenByHash(tokenHash: string): Promise<LeaseCapabilityToken | null>;
  get(id: string): Promise<MachineLease | null>;
  getByOrderId(orderId: string): Promise<MachineLease | null>;
  markActive(
    id: string,
    providerServerId: string,
    host: string,
    username: string,
    providerSshKeyId?: string,
    providerFirewallId?: string,
  ): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
  markTerminating(id: string): Promise<MachineLease | null>;
  markTerminated(id: string): Promise<void>;
  extendLease(id: string, expiresAt: string): Promise<void>;
  expiredLeases(now?: Date): Promise<MachineLease[]>;
  provisioningLeases(): Promise<MachineLease[]>;
  pruneRetired(now: Date, retentionMs: number): Promise<number>;
}

function isRetired(status: MachineStatus): boolean {
  return status === "terminated" || status === "failed";
}

// A lease is prunable once it has reached a terminal state and its most recent
// relevant timestamp is older than the retention window.
function prunableBefore(lease: MachineLease, cutoff: number): boolean {
  if (!isRetired(lease.status)) {
    return false;
  }
  const stamp = Date.parse(lease.terminatedAt ?? lease.expiresAt);
  return Number.isFinite(stamp) && stamp <= cutoff;
}

function applyPrune(data: StoreFile, cutoff: number): { data: StoreFile; removed: number } {
  const pruned = new Set(data.machines.filter((lease) => prunableBefore(lease, cutoff)).map((lease) => lease.id));
  if (pruned.size === 0) {
    return { data, removed: 0 };
  }
  return {
    data: {
      machines: data.machines.filter((lease) => !pruned.has(lease.id)),
      capabilityTokens: data.capabilityTokens.filter((token) => !pruned.has(token.machineId)),
    },
    removed: pruned.size,
  };
}

export class FileLeaseStore implements LeaseStoreBackend {
  constructor(private readonly dataPath: string) {}

  async create(lease: MachineLease): Promise<void> {
    await this.update((data) => {
      data.machines.push(lease);
      return data;
    });
  }

  async createCapabilityTokens(tokens: LeaseCapabilityToken[]): Promise<void> {
    await this.update((data) => {
      data.capabilityTokens.push(...tokens);
      return data;
    });
  }

  async getCapabilityTokenByHash(tokenHash: string): Promise<LeaseCapabilityToken | null> {
    const data = await this.read();
    return data.capabilityTokens.find((token) => token.tokenHash === tokenHash) ?? null;
  }

  async get(id: string): Promise<MachineLease | null> {
    const data = await this.read();
    return data.machines.find((lease) => lease.id === id) ?? null;
  }

  async getByOrderId(orderId: string): Promise<MachineLease | null> {
    const data = await this.read();
    return data.machines.find((lease) => lease.orderId === orderId) ?? null;
  }

  async markActive(
    id: string,
    providerServerId: string,
    host: string,
    username: string,
    providerSshKeyId?: string,
    providerFirewallId?: string,
  ) {
    await this.patch(id, {
      status: "active",
      providerServerId,
      providerSshKeyId: providerSshKeyId ?? null,
      providerFirewallId: providerFirewallId ?? null,
      host,
      username,
      failureReason: null,
    });
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.patch(id, {
      status: "failed",
      failureReason: reason,
    });
  }

  async markTerminating(id: string): Promise<MachineLease | null> {
    const lease = await this.get(id);
    if (!lease) {
      return null;
    }
    if (["terminated", "terminating", "failed"].includes(lease.status)) {
      return lease;
    }
    await this.patch(id, { status: "terminating" });
    return lease;
  }

  async markTerminated(id: string): Promise<void> {
    await this.patch(id, {
      status: "terminated",
      terminatedAt: new Date().toISOString(),
    });
  }

  async extendLease(id: string, expiresAt: string): Promise<void> {
    await this.update((data) => {
      data.machines = data.machines.map((lease) => (lease.id === id ? { ...lease, expiresAt } : lease));
      data.capabilityTokens = data.capabilityTokens.map((token) =>
        token.machineId === id ? { ...token, expiresAt } : token,
      );
      return data;
    });
  }

  async expiredLeases(now = new Date()): Promise<MachineLease[]> {
    const data = await this.read();
    return data.machines
      .filter((lease) => isExpirable(lease.status) && Date.parse(lease.expiresAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  }

  async provisioningLeases(): Promise<MachineLease[]> {
    const data = await this.read();
    return data.machines.filter((lease) => lease.status === "provisioning");
  }

  async pruneRetired(now: Date, retentionMs: number): Promise<number> {
    let removed = 0;
    await this.update((data) => {
      const result = applyPrune(data, now.getTime() - retentionMs);
      removed = result.removed;
      return result.data;
    });
    return removed;
  }

  private async patch(id: string, updates: Partial<MachineLease>): Promise<void> {
    await this.update((data) => {
      data.machines = data.machines.map((lease) => (lease.id === id ? { ...lease, ...updates } : lease));
      return data;
    });
  }

  private async update(mutator: (data: StoreFile) => StoreFile): Promise<void> {
    const data = mutator(await this.read());
    await mkdir(dirname(this.dataPath), { recursive: true });
    const tmpPath = `${this.dataPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.dataPath);
  }

  private async read(): Promise<StoreFile> {
    try {
      const raw = await readFile(this.dataPath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      return {
        machines: Array.isArray(parsed.machines) ? parsed.machines : [],
        capabilityTokens: Array.isArray(parsed.capabilityTokens) ? parsed.capabilityTokens : [],
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return { machines: [], capabilityTokens: [] };
      }
      throw error;
    }
  }
}

export class RedisRestLeaseStore implements LeaseStoreBackend {
  private readonly lockKey: string;

  constructor(
    private readonly restUrl: string,
    private readonly token: string,
    private readonly dataKey: string,
  ) {
    this.lockKey = `${dataKey}:lock`;
  }

  async create(lease: MachineLease): Promise<void> {
    await this.update((data) => {
      data.machines.push(lease);
      return data;
    });
  }

  async createCapabilityTokens(tokens: LeaseCapabilityToken[]): Promise<void> {
    await this.update((data) => {
      data.capabilityTokens.push(...tokens);
      return data;
    });
  }

  async getCapabilityTokenByHash(tokenHash: string): Promise<LeaseCapabilityToken | null> {
    const data = await this.read();
    return data.capabilityTokens.find((token) => token.tokenHash === tokenHash) ?? null;
  }

  async get(id: string): Promise<MachineLease | null> {
    const data = await this.read();
    return data.machines.find((lease) => lease.id === id) ?? null;
  }

  async getByOrderId(orderId: string): Promise<MachineLease | null> {
    const data = await this.read();
    return data.machines.find((lease) => lease.orderId === orderId) ?? null;
  }

  async markActive(
    id: string,
    providerServerId: string,
    host: string,
    username: string,
    providerSshKeyId?: string,
    providerFirewallId?: string,
  ) {
    await this.patch(id, {
      status: "active",
      providerServerId,
      providerSshKeyId: providerSshKeyId ?? null,
      providerFirewallId: providerFirewallId ?? null,
      host,
      username,
      failureReason: null,
    });
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.patch(id, {
      status: "failed",
      failureReason: reason,
    });
  }

  async markTerminating(id: string): Promise<MachineLease | null> {
    const lease = await this.get(id);
    if (!lease) {
      return null;
    }
    if (["terminated", "terminating", "failed"].includes(lease.status)) {
      return lease;
    }
    await this.patch(id, { status: "terminating" });
    return lease;
  }

  async markTerminated(id: string): Promise<void> {
    await this.patch(id, {
      status: "terminated",
      terminatedAt: new Date().toISOString(),
    });
  }

  async extendLease(id: string, expiresAt: string): Promise<void> {
    await this.update((data) => {
      data.machines = data.machines.map((lease) => (lease.id === id ? { ...lease, expiresAt } : lease));
      data.capabilityTokens = data.capabilityTokens.map((token) =>
        token.machineId === id ? { ...token, expiresAt } : token,
      );
      return data;
    });
  }

  async expiredLeases(now = new Date()): Promise<MachineLease[]> {
    const data = await this.read();
    return data.machines
      .filter((lease) => isExpirable(lease.status) && Date.parse(lease.expiresAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  }

  async provisioningLeases(): Promise<MachineLease[]> {
    const data = await this.read();
    return data.machines.filter((lease) => lease.status === "provisioning");
  }

  async pruneRetired(now: Date, retentionMs: number): Promise<number> {
    let removed = 0;
    await this.update((data) => {
      const result = applyPrune(data, now.getTime() - retentionMs);
      removed = result.removed;
      return result.data;
    });
    return removed;
  }

  private async patch(id: string, updates: Partial<MachineLease>): Promise<void> {
    await this.update((data) => {
      data.machines = data.machines.map((lease) => (lease.id === id ? { ...lease, ...updates } : lease));
      return data;
    });
  }

  private async update(mutator: (data: StoreFile) => StoreFile): Promise<void> {
    const lockToken = await this.acquireLock();
    try {
      await this.write(mutator(await this.read()));
    } finally {
      await this.releaseLock(lockToken);
    }
  }

  private async read(): Promise<StoreFile> {
    const raw = await this.command<unknown>(["GET", this.dataKey]);
    if (typeof raw !== "string" || !raw) {
      return emptyStore();
    }
    const parsed = JSON.parse(raw) as StoreFile;
    return normalizeStore(parsed);
  }

  private async write(data: StoreFile): Promise<void> {
    await this.command(["SET", this.dataKey, JSON.stringify(data)]);
  }

  private async acquireLock(): Promise<string> {
    const token = randomUUID();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await this.command<unknown>(["SET", this.lockKey, token, "NX", "PX", "10000"]);
      if (result === "OK") {
        return token;
      }
      await delay(125);
    }
    throw new Error("Timed out acquiring lease-store lock.");
  }

  private async releaseLock(token: string): Promise<void> {
    const current = await this.command<unknown>(["GET", this.lockKey]);
    if (current === token) {
      await this.command(["DEL", this.lockKey]);
    }
  }

  private async command<T = unknown>(command: unknown[]): Promise<T> {
    const response = await fetch(this.restUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      throw new Error(`Redis REST command failed with ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as { result?: T; error?: string };
    if (payload.error) {
      throw new Error(`Redis REST command failed: ${payload.error}`);
    }
    return payload.result as T;
  }
}

export { FileLeaseStore as LeaseStore };

function isExpirable(status: MachineStatus): boolean {
  return status === "active" || status === "provisioning";
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function emptyStore(): StoreFile {
  return { machines: [], capabilityTokens: [] };
}

function normalizeStore(parsed: StoreFile): StoreFile {
  return {
    machines: Array.isArray(parsed.machines) ? parsed.machines : [],
    capabilityTokens: Array.isArray(parsed.capabilityTokens) ? parsed.capabilityTokens : [],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
