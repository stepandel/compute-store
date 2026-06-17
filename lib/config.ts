export type Product = {
  id: "bare-linux-machine";
  defaultProvider: "hetzner";
  serverType: string;
  image: string;
  location: string;
  username: string;
  minDurationMinutes: number;
  maxDurationMinutes: number;
};

export type ProviderName = "dry-run" | "hetzner";

export type Settings = {
  dataPath: string;
  provider: ProviderName;
  hetznerApiToken?: string;
  allowUnpaidMachineCreate: boolean;
  product: Product;
  checkout: CheckoutSettings;
};

export type CheckoutSettings = {
  baseFeeCents: number;
  priceCentsPerMinute: number;
  currency: "usd";
  mppSecretKey?: string;
  sandboxAutopay: boolean;
  stripeSecretKey?: string;
  stripeProfileId?: string;
  stripePaymentMethodTypes: string[];
};

export const product: Product = {
  id: "bare-linux-machine",
  defaultProvider: "hetzner",
  serverType: "cx23",
  image: "ubuntu-24.04",
  location: "fsn1",
  username: "root",
  minDurationMinutes: 15,
  maxDurationMinutes: 360,
};

export function loadSettings(): Settings {
  const provider = (process.env.PROVIDER ?? "dry-run") as ProviderName;
  const baseFeeCents = parseNonNegativeInteger(process.env.CHECKOUT_BASE_FEE_CENTS, "CHECKOUT_BASE_FEE_CENTS", 99);
  const priceCentsPerMinute = parsePositiveInteger(
    process.env.PRICE_CENTS_PER_MINUTE,
    "PRICE_CENTS_PER_MINUTE",
    5,
  );

  if (provider !== "dry-run" && provider !== "hetzner") {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  return {
    dataPath: process.env.DATA_PATH ?? "data/machines.json",
    provider,
    hetznerApiToken: process.env.HETZNER_API_TOKEN,
    allowUnpaidMachineCreate: process.env.ALLOW_UNPAID_MACHINE_CREATE === "true" || provider === "dry-run",
    product,
    checkout: {
      baseFeeCents,
      priceCentsPerMinute,
      currency: "usd",
      mppSecretKey: process.env.MPP_SECRET_KEY,
      sandboxAutopay: process.env.CHECKOUT_SANDBOX_AUTOPAY === "true",
      stripeSecretKey: process.env.STRIPE_SECRET_KEY,
      stripeProfileId: process.env.STRIPE_PROFILE_ID,
      stripePaymentMethodTypes: parseCsv(process.env.STRIPE_PAYMENT_METHOD_TYPES, ["card", "link"]),
    },
  };
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
