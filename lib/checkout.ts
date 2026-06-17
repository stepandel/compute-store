import Stripe from "stripe";
import { Mppx, stripe as mppStripe, tempo } from "mppx/server";
import { loadSettings, type CheckoutSettings } from "@/lib/config";
import type { CreateMachineRequest } from "@/lib/models";

const TEMPO_USD_TESTNET = "0x20c0000000000000000000000000000000000000";
const TEN_MINUTES_MS = 10 * 60 * 1000;

export class CheckoutConfigurationError extends Error {}

export type CheckoutQuote = {
  product_id: string;
  duration_minutes: number;
  unit_price_cents_per_minute: number;
  amount_cents: number;
  amount: string;
  currency: "usd";
};

export type MppCheckout = {
  enabledMethods: Array<"stripe" | "tempo">;
  payment: ReturnType<typeof Mppx.create>;
};

export function quoteCheckout(request: CreateMachineRequest): CheckoutQuote {
  const settings = loadSettings();
  const amountCents = request.durationMinutes * settings.checkout.priceCentsPerMinute;

  return {
    product_id: settings.product.id,
    duration_minutes: request.durationMinutes,
    unit_price_cents_per_minute: settings.checkout.priceCentsPerMinute,
    amount_cents: amountCents,
    amount: formatUsdAmount(amountCents),
    currency: settings.checkout.currency,
  };
}

export function createMppCheckout(): MppCheckout {
  const settings = loadSettings();
  const configured = buildPaymentMethods(settings.checkout);

  if (!settings.checkout.mppSecretKey) {
    throw new CheckoutConfigurationError("MPP_SECRET_KEY is required before paid checkout can accept MPP payments.");
  }
  if (!configured.methods.length) {
    throw new CheckoutConfigurationError(
      "Configure STRIPE_SECRET_KEY and STRIPE_PROFILE_ID, or TEMPO_RECIPIENT_ADDRESS, before paid checkout can accept MPP payments.",
    );
  }

  return {
    enabledMethods: configured.enabledMethods,
    payment: Mppx.create({
      methods: configured.methods,
      secretKey: settings.checkout.mppSecretKey,
    }),
  };
}

export function checkoutComposeEntries(checkout: MppCheckout, quote: CheckoutQuote) {
  return checkout.enabledMethods.map((method) => [
    `${method}/charge`,
    {
      amount: quote.amount,
      description: `${quote.duration_minutes} minute ${quote.product_id} lease`,
      expires: checkoutChallengeExpires(),
      meta: {
        product_id: quote.product_id,
        duration_minutes: String(quote.duration_minutes),
        amount_cents: String(quote.amount_cents),
      },
      scope: "checkout:create-machine",
    },
  ]) as Parameters<MppCheckout["payment"]["compose"]>;
}

export function checkoutChallengeExpires(): Date {
  return new Date(Date.now() + TEN_MINUTES_MS);
}

function buildPaymentMethods(settings: CheckoutSettings) {
  const methods = [];
  const enabledMethods: Array<"stripe" | "tempo"> = [];

  if (settings.stripeSecretKey && settings.stripeProfileId) {
    const stripeClient = new Stripe(settings.stripeSecretKey, {
      apiVersion: "2026-05-27.dahlia",
    });

    methods.push(
      mppStripe.charge({
        client: stripeClient,
        networkId: settings.stripeProfileId,
        currency: settings.currency,
        decimals: 2,
        paymentMethodTypes: settings.stripePaymentMethodTypes,
      }),
    );
    enabledMethods.push("stripe");
  }

  if (settings.tempoRecipientAddress) {
    methods.push(
      tempo.charge({
        currency: TEMPO_USD_TESTNET,
        decimals: 6,
        recipient: settings.tempoRecipientAddress,
        testnet: settings.tempoTestnet,
      }),
    );
    enabledMethods.push("tempo");
  }

  return {
    enabledMethods,
    methods,
  };
}

function formatUsdAmount(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}
