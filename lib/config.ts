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

  if (provider !== "dry-run" && provider !== "hetzner") {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  return {
    dataPath: process.env.DATA_PATH ?? "data/machines.json",
    provider,
    hetznerApiToken: process.env.HETZNER_API_TOKEN,
    product,
  };
}

