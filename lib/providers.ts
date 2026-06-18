import type { Product, Settings } from "@/lib/config";
import type { MachineLease, ProvisionedMachine } from "@/lib/models";

export class ProviderError extends Error {}

export interface ComputeProvider {
  provision(lease: MachineLease): Promise<ProvisionedMachine>;
  terminate(lease: MachineLease): Promise<void>;
}

export class DryRunProvider implements ComputeProvider {
  async provision(lease: MachineLease): Promise<ProvisionedMachine> {
    await delay(50);
    return {
      providerServerId: `dryrun-${lease.id}`,
      host: "203.0.113.10",
      username: lease.username,
    };
  }

  async terminate(): Promise<void> {
    await delay(10);
  }
}

export class HetznerProvider implements ComputeProvider {
  private readonly baseUrl = "https://api.hetzner.cloud/v1";

  constructor(
    private readonly token: string,
    private readonly product: Product,
  ) {}

  async provision(lease: MachineLease): Promise<ProvisionedMachine> {
    let sshKeyId: string | null = null;
    let firewallId: string | null = null;
    let serverId: string | null = null;

    try {
      const resourceName = hetznerResourceName(lease.id);

      const sshKey = await this.request<{ ssh_key: { id: number } }>("POST", "/ssh_keys", {
        name: `storefront-${resourceName}`,
        public_key: lease.sshPublicKey,
      });
      sshKeyId = String(sshKey.ssh_key.id);

      const firewall = await this.request<{ firewall: { id: number } }>("POST", "/firewalls", {
        name: `lease-${resourceName}-ssh-only`,
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "22",
            source_ips: ["0.0.0.0/0", "::/0"],
          },
        ],
        labels: leaseLabels(lease),
      });
      firewallId = String(firewall.firewall.id);

      const server = await this.request<{
        server: { id: number; public_net?: { ipv4?: { ip?: string } } };
      }>("POST", "/servers", {
        name: `lease-${resourceName}`,
        server_type: this.product.serverType,
        image: this.product.image,
        location: this.product.location,
        ssh_keys: [Number(sshKeyId)],
        firewalls: [{ firewall: Number(firewallId) }],
        labels: leaseLabels(lease),
      });
      serverId = String(server.server.id);
      const host = server.server.public_net?.ipv4?.ip ?? (await this.waitForIpv4(serverId));

      return {
        providerServerId: serverId,
        providerSshKeyId: sshKeyId,
        providerFirewallId: firewallId,
        host,
        username: this.product.username,
      };
    } catch (error) {
      await this.cleanupPartialProvision({ serverId, sshKeyId, firewallId });
      throw error;
    }
  }

  async terminate(lease: MachineLease): Promise<void> {
    if (lease.providerServerId) {
      await this.request("DELETE", `/servers/${lease.providerServerId}`, undefined, true);
    }
    if (lease.providerSshKeyId) {
      await this.request("DELETE", `/ssh_keys/${lease.providerSshKeyId}`, undefined, true);
    }
    if (lease.providerFirewallId) {
      await this.deleteFirewall(lease.providerFirewallId);
    }
  }

  private async waitForIpv4(serverId: string): Promise<string> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const payload = await this.request<{ server: { public_net?: { ipv4?: { ip?: string } } } }>(
        "GET",
        `/servers/${serverId}`,
      );
      const host = payload.server.public_net?.ipv4?.ip;
      if (host) {
        return host;
      }
      await delay(2000);
    }
    throw new ProviderError(`Timed out waiting for IPv4 address on server ${serverId}.`);
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    ignoreNotFound = false,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (ignoreNotFound && response.status === 404) {
      return {} as T;
    }
    if (!response.ok) {
      throw new ProviderError(`Hetzner API returned ${response.status}: ${await response.text()}`);
    }
    if (response.status === 204) {
      return {} as T;
    }
    return (await response.json()) as T;
  }

  private async cleanupPartialProvision(ids: {
    serverId: string | null;
    sshKeyId: string | null;
    firewallId: string | null;
  }): Promise<void> {
    if (ids.serverId) {
      await this.request("DELETE", `/servers/${ids.serverId}`, undefined, true).catch(() => undefined);
    }
    if (ids.sshKeyId) {
      await this.request("DELETE", `/ssh_keys/${ids.sshKeyId}`, undefined, true).catch(() => undefined);
    }
    if (ids.firewallId) {
      await this.deleteFirewall(ids.firewallId).catch(() => undefined);
    }
  }

  private async deleteFirewall(id: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await this.request("DELETE", `/firewalls/${id}`, undefined, true);
        return;
      } catch (error) {
        lastError = error;
        await delay(1000);
      }
    }
    throw lastError;
  }
}

export function buildProvider(settings: Settings): ComputeProvider {
  if (settings.provider === "dry-run") {
    return new DryRunProvider();
  }
  if (!settings.hetznerApiToken) {
    throw new ProviderError("HETZNER_API_TOKEN is required when PROVIDER=hetzner.");
  }
  return new HetznerProvider(settings.hetznerApiToken, settings.product);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leaseLabels(lease: MachineLease): Record<string, string> {
  return {
    managed_by: "agentic-storefront",
    lease_id: lease.id,
    product: lease.productId,
  };
}

function hetznerResourceName(id: string): string {
  return id.replaceAll("_", "-").toLowerCase();
}
