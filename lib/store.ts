import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MachineLease, MachineStatus } from "@/lib/models";

type StoreFile = {
  machines: MachineLease[];
};

export class LeaseStore {
  constructor(private readonly dataPath: string) {}

  async create(lease: MachineLease): Promise<void> {
    await this.update((data) => {
      data.machines.push(lease);
      return data;
    });
  }

  async get(id: string): Promise<MachineLease | null> {
    const data = await this.read();
    return data.machines.find((lease) => lease.id === id) ?? null;
  }

  async markActive(id: string, providerServerId: string, host: string, username: string, providerSshKeyId?: string) {
    await this.patch(id, {
      status: "active",
      providerServerId,
      providerSshKeyId: providerSshKeyId ?? null,
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

  async expiredLeases(now = new Date()): Promise<MachineLease[]> {
    const data = await this.read();
    return data.machines
      .filter((lease) => isExpirable(lease.status) && Date.parse(lease.expiresAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
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
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return { machines: [] };
      }
      throw error;
    }
  }
}

function isExpirable(status: MachineStatus): boolean {
  return status === "active" || status === "provisioning";
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

