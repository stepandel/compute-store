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
  product: Product;
  checkout: CheckoutSettings;
};

export type CheckoutSettings = {
  priceCentsPerMinute: number;
  currency: "usd";
  mppSecretKey?: string;
  stripeSecretKey?: string;
  stripeProfileId?: string;
  stripePaymentMethodTypes: string[];
};

export const product: Product = {
  id: "bare-linux-machine",
  defaultProvider: "hetzner",
  serverType: "cx22",
  image: "ubuntu-24.04",
  location: "fsn1",
  username: "root",
  minDurationMinutes: 15,
  maxDurationMinutes: 360,
};

export function loadSettings(): Settings {
  const provider = (process.env.PROVIDER ?? "dry-run") as ProviderName;
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
    product,
    checkout: {
      priceCentsPerMinute,
      currency: "usd",
      mppSecretKey: process.env.MPP_SECRET_KEY,
      stripeSecretKey: process.env.STRIPE_SECRET_KEY,
      stripeProfileId: process.env.STRIPE_PROFILE_ID,
      stripePaymentMethodTypes: parseCsv(process.env.STRIPE_PAYMENT_METHOD_TYPES, ["card", "link"]),
    },
  };
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
