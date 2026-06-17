import { randomUUID } from "node:crypto";
import { loadSettings, type Product, type ProviderName } from "@/lib/config";
import { buildProvider, type ComputeProvider } from "@/lib/providers";
import type { CreateMachineRequest, MachineLease } from "@/lib/models";
import { LeaseStore } from "@/lib/store";

export class MachineService {
  constructor(
    private readonly store: LeaseStore,
    private readonly provider: ComputeProvider,
    private readonly product: Product,
    private readonly providerName: ProviderName,
  ) {}

  async createMachine(request: CreateMachineRequest): Promise<MachineLease> {
    await this.expireDueMachines();

    const now = new Date();
    const lease: MachineLease = {
      id: `machine_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      productId: this.product.id,
      provider: this.providerName,
      providerServerId: null,
      providerSshKeyId: null,
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
    this.provision(lease.id).catch(() => undefined);
    return lease;
  }

  async getMachine(id: string): Promise<MachineLease | null> {
    await this.expireDueMachines();
    return this.store.get(id);
  }

  async terminateMachine(id: string): Promise<MachineLease | null> {
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
      );
    } catch (error) {
      await this.store.markFailed(id, errorMessage(error));
    }
  }
}

export function createMachineService() {
  const settings = loadSettings();
  return new MachineService(
    new LeaseStore(settings.dataPath),
    buildProvider(settings),
    settings.product,
    settings.provider,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
