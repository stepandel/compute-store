import type { ProductId } from "@/lib/config";

export type MachineStatus = "provisioning" | "active" | "terminating" | "terminated" | "failed";
export type CapabilityAction = "read" | "extend" | "terminate";

export type CreateMachineRequest = {
  // Which product to lease. Required: the buyer must pick a SKU.
  productId: ProductId;
  durationMinutes: number;
  sshPublicKey: string;
  // Optional client-supplied correlation id. Reused verbatim across the
  // validate → 402 challenge → paid retry calls so the same logical order
  // resolves to the same payment challenge. Not required for payment.
  requestId?: string;
};

export type ProvisionedMachine = {
  providerServerId: string;
  providerSshKeyId?: string;
  providerFirewallId?: string;
  host: string;
  username: string;
  // Non-standard SSH port, when the backend does not expose 22 directly
  // (e.g. RunPod maps SSH to a forwarded TCP port). Omitted means port 22.
  sshPort?: number;
};

export type MachineLease = {
  id: string;
  productId: string;
  provider: string;
  providerServerId: string | null;
  providerSshKeyId: string | null;
  providerFirewallId: string | null;
  status: MachineStatus;
  sshPublicKey: string;
  host: string | null;
  sshPort: number | null;
  username: string;
  createdAt: string;
  expiresAt: string;
  terminatedAt: string | null;
  failureReason: string | null;
  // MPP order linkage. orderId is derived deterministically from the buyer's
  // request_id (the idempotency key), so the same order resolves to the same
  // lease across the create → pay → poll lifecycle. Null on legacy/dev leases.
  orderId: string | null;
  requestId: string | null;
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

// MPP order model, mirroring PostalForm's /api/machine/mpp/orders responses.
// In our domain an "order" is a paid machine lease: order_id is the stable
// handle, and payment/fulfilment status is projected from the lease.
export type OrderPaymentStatus = "unpaid" | "paid" | "settled_pending_webhook";
export type OrderStatus = "unpaid" | "settled" | "settled_pending_webhook";

export type MppOrder = {
  order_id: string;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  is_paid: boolean;
  current_step: string;
  order_complete_url: string;
  machine?: PublicMachine;
};

// Coarse fulfilment step projected from the lease status. Kept payment-centric
// and non-sensitive so it can be returned by the unauthenticated order poll.
export function orderCurrentStep(status: MachineStatus): string {
  switch (status) {
    case "provisioning":
      return "provisioning";
    case "active":
      return "ready";
    case "terminating":
      return "terminating";
    case "terminated":
      return "terminated";
    case "failed":
      return "failed";
  }
}

export function toMppOrder(
  lease: MachineLease,
  serviceUrl: string,
  options: { management?: MachineManagementTokens; includeMachine?: boolean } = {},
): MppOrder {
  const orderId = lease.orderId ?? lease.id;
  // A persisted lease only ever exists post-payment (we provision after MPP
  // confirms settlement), so a found order is always paid/settled.
  const order: MppOrder = {
    order_id: orderId,
    status: "settled",
    payment_status: "paid",
    is_paid: true,
    current_step: orderCurrentStep(lease.status),
    order_complete_url: new URL(`/api/machine/mpp/orders/${orderId}`, serviceUrl).toString(),
  };
  if (options.includeMachine) {
    order.machine = toPublicMachine(lease, options.management);
  }
  return order;
}

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
    const portFlag = lease.sshPort && lease.sshPort !== 22 ? ` -p ${lease.sshPort}` : "";
    body.ssh_command = `ssh ${lease.username}@${lease.host}${portFlag}`;
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
