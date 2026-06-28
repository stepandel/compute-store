export type ProductId = "bare-linux-machine" | "gpu-h100-machine";

// The concrete backend a lease was provisioned on (persisted on the lease so
// lifecycle ops can rebuild the right provider). "dry-run" simulates everything.
export type ProviderName = "dry-run" | "hetzner" | "runpod";

// Real backend a product is provisioned on when running live.
export type RealProviderName = Exclude<ProviderName, "dry-run">;

// Global toggle: "dry-run" simulates provisioning for every product; "live"
// provisions each product on its own backend (Hetzner for CPU, RunPod for GPU).
export type ProviderMode = "dry-run" | "live";

export type Product = {
  id: ProductId;
  label: string;
  defaultProvider: RealProviderName;
  // Hetzner server_type (e.g. "cx23") or RunPod GPU type id (e.g. "NVIDIA H100 80GB HBM3").
  serverType: string;
  image: string;
  location: string;
  username: string;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  baseFeeCents: number;
  priceCentsPerMinute: number;
};

export type Settings = {
  dataPath: string;
  leaseStore: LeaseStoreName;
  redisRestUrl?: string;
  redisRestToken?: string;
  redisRestKey: string;
  providerMode: ProviderMode;
  hetznerApiToken?: string;
  runpodApiToken?: string;
  allowUnpaidMachineCreate: boolean;
  products: Record<ProductId, Product>;
  checkout: CheckoutSettings;
};

export type LeaseStoreName = "file" | "redis-rest";
// Per-product pricing now lives on Product; CheckoutSettings carries only the
// payment-processor configuration shared across products.
export type CheckoutSettings = {
  currency: "usd";
  mppSecretKey?: string;
  stripeSecretKey?: string;
  stripeProfileId?: string;
  stripePaymentMethodTypes: string[];
};

export const PRODUCT_IDS: ProductId[] = ["bare-linux-machine", "gpu-h100-machine"];
export const DEFAULT_PRODUCT_ID: ProductId = "bare-linux-machine";

export function isProductId(value: unknown): value is ProductId {
  return typeof value === "string" && (PRODUCT_IDS as string[]).includes(value);
}

// Pricing is read from env on each call (call-time, not import-time) so the
// quote always reflects the current configuration and tests can override it.
function productRegistry(): Record<ProductId, Product> {
  return {
    "bare-linux-machine": {
      id: "bare-linux-machine",
      label: "Bare Linux machine",
      defaultProvider: "hetzner",
      serverType: "cx23",
      image: "ubuntu-24.04",
      location: "fsn1",
      username: "root",
      minDurationMinutes: 15,
      maxDurationMinutes: 360,
      baseFeeCents: parseNonNegativeInteger(process.env.CHECKOUT_BASE_FEE_CENTS, "CHECKOUT_BASE_FEE_CENTS", 99),
      priceCentsPerMinute: parsePositiveInteger(process.env.PRICE_CENTS_PER_MINUTE, "PRICE_CENTS_PER_MINUTE", 5),
    },
    "gpu-h100-machine": {
      id: "gpu-h100-machine",
      label: "H100 GPU machine",
      defaultProvider: "runpod",
      // RunPod GPU type id. The provider matches the pod to this GPU.
      serverType: "NVIDIA H100 80GB HBM3",
      image: "runpod/pytorch:2.2.0-py3.10-cuda12.1.1-devel-ubuntu22.04",
      location: "US",
      username: "root",
      minDurationMinutes: 15,
      maxDurationMinutes: 360,
      // GPU is priced like the CPU box (flat base fee + per-minute) but higher:
      // a RunPod H100 runs ~$2.40-2.70/hr (~4-5 cents/min) at cost, so the
      // default 9 cents/min ($5.40/hr) leaves margin. Operator-tunable via env.
      baseFeeCents: parseNonNegativeInteger(
        process.env.GPU_CHECKOUT_BASE_FEE_CENTS,
        "GPU_CHECKOUT_BASE_FEE_CENTS",
        199,
      ),
      priceCentsPerMinute: parsePositiveInteger(
        process.env.GPU_PRICE_CENTS_PER_MINUTE,
        "GPU_PRICE_CENTS_PER_MINUTE",
        9,
      ),
    },
  };
}

export function getProducts(): Record<ProductId, Product> {
  return productRegistry();
}

export function getProduct(id: ProductId): Product {
  return productRegistry()[id];
}

// Default product descriptor, for static consumers (health, marketing page,
// tests). Pricing reflects env at import time; for live quotes use getProduct().
export const product: Product = getProduct(DEFAULT_PRODUCT_ID);

export function loadSettings(): Settings {
  const providerMode = parseProviderMode(process.env.PROVIDER);
  const leaseStore = (process.env.LEASE_STORE ?? "file") as LeaseStoreName;

  if (leaseStore !== "file" && leaseStore !== "redis-rest") {
    throw new Error(`Unsupported lease store: ${leaseStore}`);
  }
  if (process.env.NODE_ENV === "production" && providerMode !== "dry-run" && leaseStore === "file") {
    throw new Error("LEASE_STORE=redis-rest is required in production when real provisioning is enabled.");
  }
  if (leaseStore === "redis-rest" && (!process.env.REDIS_REST_URL || !process.env.REDIS_REST_TOKEN)) {
    throw new Error("REDIS_REST_URL and REDIS_REST_TOKEN are required when LEASE_STORE=redis-rest.");
  }

  return {
    dataPath: process.env.DATA_PATH ?? "data/machines.json",
    leaseStore,
    redisRestUrl: process.env.REDIS_REST_URL,
    redisRestToken: process.env.REDIS_REST_TOKEN,
    redisRestKey: process.env.REDIS_REST_KEY ?? "checkout-proto:leases",
    providerMode,
    hetznerApiToken: process.env.HETZNER_API_TOKEN,
    runpodApiToken: process.env.RUNPOD_API_TOKEN,
    allowUnpaidMachineCreate: process.env.ALLOW_UNPAID_MACHINE_CREATE === "true",
    products: productRegistry(),
    checkout: {
      currency: "usd",
      mppSecretKey: process.env.MPP_SECRET_KEY,
      stripeSecretKey: process.env.STRIPE_SECRET_KEY,
      stripeProfileId: process.env.STRIPE_PROFILE_ID,
      stripePaymentMethodTypes: parseCsv(process.env.STRIPE_PAYMENT_METHOD_TYPES, ["card", "link"]),
    },
  };
}

// PROVIDER selects the mode: "dry-run" (default) simulates all products; any
// real-provider value ("live", "hetzner", "runpod") enables live provisioning,
// where each product is routed to its own backend.
function parseProviderMode(value: string | undefined): ProviderMode {
  if (!value || value === "dry-run") {
    return "dry-run";
  }
  if (value === "live" || value === "hetzner" || value === "runpod") {
    return "live";
  }
  throw new Error(`Unsupported provider: ${value}. Use dry-run or live.`);
}

function parseNonNegativeInteger(value: string | undefined, name: string, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}
