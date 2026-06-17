export type MachineStatus = "provisioning" | "active" | "terminating" | "terminated" | "failed";
export type CapabilityAction = "read" | "extend" | "terminate";

export type CreateMachineRequest = {
  durationMinutes: number;
  sshPublicKey: string;
};

export type ProvisionedMachine = {
  providerServerId: string;
  providerSshKeyId?: string;
  host: string;
  username: string;
};

export type MachineLease = {
  id: string;
  productId: string;
  provider: string;
  providerServerId: string | null;
  providerSshKeyId: string | null;
  status: MachineStatus;
  sshPublicKey: string;
  host: string | null;
  username: string;
  createdAt: string;
  expiresAt: string;
  terminatedAt: string | null;
  failureReason: string | null;
};

export type LeaseCapabilityToken = {
  id: string;
  machineId: string;
  tokenHash: string;
  actions: CapabilityAction[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type MachineManagementTokens = {
  read_token: string;
  extend_token: string;
  terminate_token: string;
};

export type PublicMachine = {
  machine_id: string;
  product: string;
  provider: string;
  status: MachineStatus;
  host: string | null;
  username: string;
  created_at: string;
  expires_at: string;
  ssh_command?: string;
  terminated_at?: string;
  failure_reason?: string;
  management?: MachineManagementTokens;
};

export function toPublicMachine(lease: MachineLease, management?: MachineManagementTokens): PublicMachine {
  const body: PublicMachine = {
    machine_id: lease.id,
    product: lease.productId,
    provider: lease.provider,
    status: lease.status,
    host: lease.host,
    username: lease.username,
    created_at: lease.createdAt,
    expires_at: lease.expiresAt,
  };

  if (lease.host && lease.status === "active") {
    body.ssh_command = `ssh ${lease.username}@${lease.host}`;
  }
  if (lease.terminatedAt) {
    body.terminated_at = lease.terminatedAt;
  }
  if (lease.failureReason) {
    body.failure_reason = lease.failureReason;
  }
  if (management) {
    body.management = management;
  }

  return body;
}
