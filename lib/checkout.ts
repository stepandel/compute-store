import Stripe from "stripe";
import { Mppx, stripe as mppStripe } from "mppx/server";
import { loadSettings, type CheckoutSettings } from "@/lib/config";
import type { CreateMachineRequest } from "@/lib/models";

const TEN_MINUTES_MS = 10 * 60 * 1000;

export class CheckoutConfigurationError extends Error {}

export type CheckoutQuote = {
  product_id: string;
  duration_minutes: number;
  base_fee_cents: number;
  unit_price_cents_per_minute: number;
  amount_cents: number;
  amount: string;
  currency: "usd";
};

export type MppCheckout = {
  payment: ReturnType<typeof Mppx.create>;
};

export function quoteCheckout(request: CreateMachineRequest): CheckoutQuote {
  const settings = loadSettings();
  const amountCents = settings.checkout.baseFeeCents + request.durationMinutes * settings.checkout.priceCentsPerMinute;

  return {
    product_id: settings.product.id,
    duration_minutes: request.durationMinutes,
    base_fee_cents: settings.checkout.baseFeeCents,
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
      "Configure STRIPE_SECRET_KEY and STRIPE_PROFILE_ID before paid checkout can accept real Stripe payments.",
    );
  }

  return {
    payment: Mppx.create({
      methods: configured.methods,
      secretKey: settings.checkout.mppSecretKey,
    }),
  };
}

export function checkoutComposeEntries(checkout: MppCheckout, quote: CheckoutQuote) {
  return [
    [
      "stripe/charge",
      {
        amount: quote.amount,
        description: `${quote.duration_minutes} minute ${quote.product_id} lease`,
        expires: checkoutChallengeExpires(),
        meta: checkoutMetadata(quote),
        scope: "checkout:create-machine",
      },
    ],
  ] as Parameters<MppCheckout["payment"]["compose"]>;
}

export function checkoutChallengeExpires(): Date {
  return new Date(Date.now() + TEN_MINUTES_MS);
}

function buildPaymentMethods(settings: CheckoutSettings) {
  if (!settings.stripeSecretKey || !settings.stripeProfileId) {
    return { methods: [] };
  }

  const stripeClient = new Stripe(settings.stripeSecretKey, {
    apiVersion: "2026-05-27.dahlia",
  });

  return {
    methods: [
      mppStripe.charge({
        client: stripeClient,
        networkId: settings.stripeProfileId,
        currency: settings.currency,
        decimals: 2,
        paymentMethodTypes: settings.stripePaymentMethodTypes,
      }),
    ],
  };
}

function formatUsdAmount(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

function checkoutMetadata(quote: CheckoutQuote): Record<string, string> {
  return {
    product_id: quote.product_id,
    duration_minutes: String(quote.duration_minutes),
    amount_cents: String(quote.amount_cents),
  };
}
