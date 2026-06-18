import Stripe from "stripe";
import { BodyDigest } from "mppx";
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

export type CheckoutMethod = {
  id: "stripe-spt";
  processor: "stripe";
  payment_method_types: string[];
};

// Payment methods the storefront accepts, surfaced by the preflight validate
// endpoint and storefront discovery. Pure read of settings — does not require
// MPP/Stripe secrets to be present, so it stays callable during preflight.
export function checkoutMethods(): CheckoutMethod[] {
  const settings = loadSettings();
  return [
    {
      id: "stripe-spt",
      processor: "stripe",
      payment_method_types: settings.checkout.stripePaymentMethodTypes,
    },
  ];
}

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

  if (!settings.checkout.mppSecretKey) {
    throw new CheckoutConfigurationError("MPP_SECRET_KEY is required before paid checkout can accept MPP payments.");
  }
  assertProductionStripeCheckoutConfigured(settings.checkout);
  const configured = buildPaymentMethods(settings.checkout);

  return {
    payment: Mppx.create({
      methods: configured.methods,
      secretKey: settings.checkout.mppSecretKey,
    }),
  };
}

export function checkoutComposeEntries(
  checkout: MppCheckout,
  quote: CheckoutQuote,
  request: CreateMachineRequest,
) {
  return [
    [
      "stripe/charge",
      {
        // The stripe/charge request schema expects a decimal/major-unit amount
        // string (e.g. "3.99") and converts to minor units itself via
        // parseUnits(amount, decimals). Passing cents here double-converts
        // (parseUnits("399", 2) = 39900 = $399.00).
        amount: quote.amount,
        description: `${quote.duration_minutes} minute ${quote.product_id} lease`,
        expires: checkoutChallengeExpires(),
        meta: checkoutMetadata(quote, request),
        scope: "checkout:create-machine",
      },
    ],
  ] as Parameters<MppCheckout["payment"]["compose"]>;
}

// Digest binding the granted token to one specific order. mppx HMAC-binds the
// challenge `meta`, but the amount alone is the same for any order of equal
// duration — so without this an SPT minted for one order could be replayed to
// provision a *different* machine (different ssh_public_key) at the same price.
// Folding the canonical order fields (including any client request_id) into the
// challenge closes that replay window. The agent must resend an identical body
// on the paid retry, which is already required for the amount to match.
export function orderDigest(request: CreateMachineRequest): string {
  return BodyDigest.compute({
    duration_minutes: request.durationMinutes,
    ssh_public_key: request.sshPublicKey,
    request_id: request.requestId ?? "",
  });
}

export function checkoutChallengeExpires(): Date {
  return new Date(Date.now() + TEN_MINUTES_MS);
}

function assertProductionStripeCheckoutConfigured(settings: CheckoutSettings): void {
  if (!settings.stripeSecretKey || !settings.stripeProfileId) {
    throw new CheckoutConfigurationError(
      "Configure STRIPE_SECRET_KEY=sk_live_... and STRIPE_PROFILE_ID=profile_... before paid checkout can accept production Stripe payments.",
    );
  }
  if (!settings.stripeSecretKey.startsWith("sk_live_") || settings.stripeProfileId.startsWith("profile_test_")) {
    throw new CheckoutConfigurationError(
      "Production checkout requires live Stripe credentials: STRIPE_SECRET_KEY=sk_live_... and STRIPE_PROFILE_ID=profile_....",
    );
  }
}

function buildPaymentMethods(settings: CheckoutSettings) {
  const stripeClient = new Stripe(settings.stripeSecretKey!, {
    apiVersion: "2026-05-27.dahlia",
  });

  return {
    methods: [
      mppStripe.charge({
        client: stripeClient,
        networkId: settings.stripeProfileId!,
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

function checkoutMetadata(quote: CheckoutQuote, request: CreateMachineRequest): Record<string, string> {
  return {
    product_id: quote.product_id,
    duration_minutes: String(quote.duration_minutes),
    amount_cents: String(quote.amount_cents),
    // HMAC-bound by mppx; binds the credential to this exact order.
    order_digest: orderDigest(request),
    ...(request.requestId !== undefined ? { request_id: request.requestId } : {}),
  };
}
