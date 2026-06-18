import Stripe from "stripe";
import { Challenge } from "mppx";
import { stripe as mppClientStripe } from "mppx/client";
import { Mppx, stripe as mppStripe } from "mppx/server";
import { loadSettings, type CheckoutSettings, type Settings } from "@/lib/config";
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
  if (
    settings.provider !== "dry-run" &&
    settings.checkout.stripeSecretKey?.startsWith("sk_test_") &&
    !settings.allowTestPaymentsWithRealProvider
  ) {
    throw new CheckoutConfigurationError(
      "Refusing to create real provider resources with Stripe test-mode payments. Set ALLOW_TEST_PAYMENTS_WITH_REAL_PROVIDER=true only for a controlled infrastructure test.",
    );
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

export function assertOperatorSponsoredSandboxCheckoutAllowed(settings: Settings = loadSettings()): void {
  if (!settings.checkout.stripeSecretKey?.startsWith("sk_test_")) {
    throw new CheckoutConfigurationError("Operator-sponsored sandbox checkout requires STRIPE_SECRET_KEY=sk_test_...");
  }
  if (!settings.checkout.stripeProfileId?.startsWith("profile_test_")) {
    throw new CheckoutConfigurationError("Operator-sponsored sandbox checkout requires STRIPE_PROFILE_ID=profile_test_...");
  }
  if (settings.provider !== "dry-run" && !settings.allowTestPaymentsWithRealProvider) {
    throw new CheckoutConfigurationError(
      "Operator-sponsored sandbox checkout with a real provider requires ALLOW_TEST_PAYMENTS_WITH_REAL_PROVIDER=true.",
    );
  }
}

export async function createOperatorSponsoredSandboxCredential(
  challengeResponse: Response,
  paymentMethod = "pm_card_visa",
): Promise<string> {
  const settings = loadSettings();
  assertOperatorSponsoredSandboxCheckoutAllowed(settings);

  const clientCharge = mppClientStripe.charge({
    createToken: async (parameters) =>
      createStripeTestSpt({
        stripeSecretKey: settings.checkout.stripeSecretKey!,
        paymentMethod: parameters.paymentMethod ?? paymentMethod,
        amount: parameters.amount,
        currency: parameters.currency,
        networkId: parameters.networkId,
        expiresAt: parameters.expiresAt,
        metadata: parameters.metadata,
      }),
    paymentMethod,
  });
  const challenge = Challenge.fromResponse(challengeResponse, { methods: [clientCharge] });

  return clientCharge.createCredential({ challenge, context: {} });
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

async function createStripeTestSpt(parameters: {
  stripeSecretKey: string;
  paymentMethod: string;
  amount: string;
  currency: string;
  networkId: string | undefined;
  expiresAt: number;
  metadata?: Record<string, string> | undefined;
}): Promise<string> {
  const body = stripeSptBody(parameters, true);
  let response = await postStripeTestSpt(parameters.stripeSecretKey, body);

  if (!response.ok && (parameters.metadata || parameters.networkId)) {
    const error = (await response.clone().json().catch(() => null)) as { error?: { message?: string } } | null;
    if (error?.error?.message?.includes("Received unknown parameter")) {
      response = await postStripeTestSpt(parameters.stripeSecretKey, stripeSptBody(parameters, false));
    }
  }

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new CheckoutConfigurationError(`Failed to create sandbox SPT: ${error?.error?.message ?? response.status}`);
  }

  const payload = (await response.json()) as { id?: string };
  if (!payload.id) {
    throw new CheckoutConfigurationError("Stripe sandbox SPT response did not include an id.");
  }
  return payload.id;
}

function stripeSptBody(
  parameters: {
    paymentMethod: string;
    amount: string;
    currency: string;
    networkId: string | undefined;
    expiresAt: number;
    metadata?: Record<string, string> | undefined;
  },
  includeSellerDetails: boolean,
): URLSearchParams {
  const body = new URLSearchParams({
    payment_method: parameters.paymentMethod,
    "usage_limits[currency]": parameters.currency,
    "usage_limits[max_amount]": parameters.amount,
    "usage_limits[expires_at]": parameters.expiresAt.toString(),
  });
  if (includeSellerDetails && parameters.networkId) {
    body.set("seller_details[network_id]", parameters.networkId);
  }
  if (includeSellerDetails && parameters.metadata) {
    for (const [key, value] of Object.entries(parameters.metadata)) {
      body.set(`metadata[${key}]`, value);
    }
  }
  return body;
}

function postStripeTestSpt(stripeSecretKey: string, body: URLSearchParams): Promise<Response> {
  return fetch("https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${stripeSecretKey}:`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}
