import { product } from "@/lib/config";
import { acceptableUsePath, prohibitedUses } from "@/lib/policy";

// Prefer an explicit public URL; on Vercel fall back to the deployment URL so
// discovery/OpenAPI never silently advertise localhost in a deployed env.
function resolveServiceUrl(request?: Request): string {
  if (process.env.NEXT_PUBLIC_STORE_URL) {
    return process.env.NEXT_PUBLIC_STORE_URL;
  }
  const forwardedHost = request?.headers.get("x-forwarded-host") ?? request?.headers.get("host");
  if (forwardedHost) {
    const forwardedProto = request?.headers.get("x-forwarded-proto") ?? "https";
    return `${forwardedProto}://${forwardedHost}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

const checkoutGuidance = [
  "Generate a UUID request_id and include it in every body. It is the idempotency key: reuse the same request_id (with an otherwise identical body) across validate, the unpaid create, and the paid retry so the same order resolves to the same payment challenge and the same order_id.",
  "Optional preflight: POST /api/machine/mpp/orders/validate with the order body to read the quote and accepted payment methods. No payment is composed and no machine is created.",
  "Use POST /api/machine/mpp/orders for purchases. Do not use POST /api/machines unless the operator explicitly enabled unpaid local/dev provisioning.",
  "The first POST /api/machine/mpp/orders (no credential) returns HTTP 402 with MPP payment challenges and { order_id, status: 'unpaid' }. Inspect the WWW-Authenticate headers and retry the identical body with a Stripe-backed MPP credential.",
  "Production checkout requires live Stripe credentials and a live Stripe Shared Payment Token for the advertised profile.",
  "If the paid retry returns HTTP 402 with credential_status: 'rejected', the credential reached the server but was not accepted (commonly a Shared Payment Token that is approved but not yet chargeable shortly after approval). The 'reason' field carries the detail. Wait a few seconds and retry the same request_id with an identical body; idempotency guarantees at most one charge. A 402 WITHOUT credential_status means no credential was attached.",
  "On success you receive HTTP 202 with the settled order (order_id, payment_status: 'paid') and the machine plus its management tokens. Store the tokens securely and poll the machine with read_token until status is active.",
  "Poll GET /api/machine/mpp/orders/{order_id} for payment_status, or the machine read endpoint for provisioning status.",
  "Terminate the machine with terminate_token as soon as the task is complete.",
];

const paymentClientGuidance = {
  recommended: {
    id: "stripe-link-cli-mpp-spt",
    name: "Stripe Link CLI MPP SPT",
    summary:
      "Recommended for agent payments. Decode the MPP challenge, create an approved Stripe Link CLI spend request with credential_type=shared_payment_token, then pay the MPP endpoint with that spend request.",
    credential_type: "shared_payment_token",
    command_sequence: [
      "npx @stripe/link-cli mpp decode --challenge '<WWW-Authenticate Payment challenge>'",
      "npx @stripe/link-cli payment-methods list",
      "npx @stripe/link-cli spend-request create --payment-method-id <payment_method_id> --credential-type shared_payment_token --network-id <network_id_from_challenge> --amount 399 --currency usd --context '<100+ character purchase rationale shown to the owner>' --line-item 'name:60 minute bare Linux machine lease,unit_amount:399,quantity:1' --total 'type:total,display_text:Total,amount:399' --request-approval",
      "npx @stripe/link-cli mpp pay {service_url}/api/machine/mpp/orders --spend-request-id <approved_spend_request_id> --method POST --header 'Content-Type: application/json' --data '{\"request_id\":\"<uuid>\",\"duration_minutes\":60,\"ssh_public_key\":\"ssh-ed25519 ...\"}'",
    ],
  },
  also_supported: [
    {
      id: "generic-mpp-stripe-spt-client",
      name: "Generic MPP client with Stripe SPT support",
      summary:
        "Any client that can read the Payment WWW-Authenticate challenge, create a Stripe Shared Payment Token for the advertised network/profile, and retry with Authorization: Payment is supported.",
      credential_type: "shared_payment_token",
    },
  ],
  unsupported: [
    {
      id: "link-cli-virtual-card",
      reason:
        "Virtual cards are for standard browser/card checkout forms. This API does not expose a card-entry checkout form; use Link CLI MPP SPT instead.",
    },
    {
      id: "manual-card-entry",
      reason: "This storefront currently exposes an agentic MPP checkout endpoint, not a human Stripe Checkout page.",
    },
    {
      id: "crypto-mpp",
      reason: "Crypto/Tempo payment challenges are intentionally not advertised or accepted for this storefront.",
    },
  ],
};

export function agentStorefrontManifest(request?: Request) {
  const serviceUrl = resolveServiceUrl(request);
  const acceptableUseUrl = new URL(acceptableUsePath, serviceUrl).toString();

  return {
    name: "Agentic Compute Storefront",
    description: "Lease a temporary bare Linux machine with SSH access and resource-scoped management tokens.",
    version: "0.1.0",
    service_url: serviceUrl,
    llms_txt_url: "/llms.txt",
    openapi_url: "/openapi.json",
    acceptable_use_url: acceptableUseUrl,
    auth: {
      type: "lease_capability_tokens",
      summary:
        "Paid checkout uses MPP. Management actions require the per-resource capability token returned after paid checkout.",
      token_handling: [
        "Treat read_token, extend_token, and terminate_token as secrets.",
        "Do not print tokens in logs or user-visible output unless explicitly required.",
        "Use only the token needed for the requested action.",
        "Terminate the machine when the task is complete.",
      ],
    },
    products: [
      {
        id: product.id,
        description: "Temporary Ubuntu Linux VM with SSH access.",
        provider_default: product.defaultProvider,
        server_type: product.serverType,
        image: product.image,
        location: product.location,
        username: product.username,
        duration_minutes: {
          minimum: product.minDurationMinutes,
          maximum: product.maxDurationMinutes,
        },
        request_schema: {
          type: "object",
          required: ["duration_minutes", "ssh_public_key"],
          properties: {
            duration_minutes: {
              type: "integer",
              minimum: product.minDurationMinutes,
              maximum: product.maxDurationMinutes,
            },
            ssh_public_key: {
              type: "string",
              description: "SSH public key to install on the leased machine.",
            },
          },
        },
      },
    ],
    payments: {
      protocol: "mpp",
      processor: "stripe",
      product_type: "machine_lease",
      validate_path: "/api/machine/mpp/orders/validate",
      checkout_path: "/api/machine/mpp/orders",
      order_status_path: "/api/machine/mpp/orders/{order_id}",
      challenge_status: 402,
      idempotency_key: "request_id",
      methods: ["stripe_spt"],
      pricing: {
        currency: "usd",
        base_fee_cents: Number(process.env.CHECKOUT_BASE_FEE_CENTS ?? 99),
        unit_amount_cents_per_minute: Number(process.env.PRICE_CENTS_PER_MINUTE ?? 5),
      },
      environment: "production",
    },
    payment_client_guidance: paymentClientGuidance,
    checkout_guidance: checkoutGuidance,
    usage_policy: {
      summary: "Machines may be used only for lawful, authorized development, automation, testing, debugging, and compute tasks.",
      prohibited_uses: prohibitedUses,
      enforcement:
        "Machines may be terminated, access may be revoked, and future checkouts may be refused for abuse, suspected abuse, provider complaints, sanctions risk, payment risk, or policy violations.",
    },
    endpoints: {
      validate: {
        method: "POST",
        path: "/api/machine/mpp/orders/validate",
        auth: "none",
        summary: "Preflight: validate the order and return the quote and payment methods. No payment, no machine created.",
      },
      checkout: {
        method: "POST",
        path: "/api/machine/mpp/orders",
        auth: "MPP payment",
        summary: "Create the order. Without a credential returns 402 with MPP challenges; with Authorization: Payment returns 202 with the settled order and machine.",
      },
      order_status: {
        method: "GET",
        path: "/api/machine/mpp/orders/{order_id}",
        auth: "none",
        summary: "Poll order payment_status by order_id (derived from request_id).",
      },
      create_dev: {
        method: "POST",
        path: "/api/machines",
        auth: "none",
        summary: "Explicitly opt-in unpaid local/dev provisioning path. Use checkout for all purchases.",
      },
      read: {
        method: "GET",
        path: "/api/machines/{machine_id}",
        auth: "Bearer <read_token>",
      },
      extend: {
        method: "POST",
        path: "/api/machines/{machine_id}/extend",
        auth: "Bearer <extend_token>",
      },
      terminate: {
        method: "DELETE",
        path: "/api/machines/{machine_id}",
        auth: "Bearer <terminate_token>",
      },
    },
    operational_guidance: [
      "Create a machine only when a temporary Linux host is required.",
      "Use only for lawful, authorized activity that complies with the acceptable use policy.",
      "Poll with the read token until status is active before using SSH.",
      "Use a live Stripe payment credential for checkout; sandbox payments are not accepted.",
      "Use the extend token only if more time is required and the lease is still useful.",
      "Use the terminate token as soon as the machine is no longer needed.",
      "If a request fails with 401 or 403, do not retry blindly; verify the correct capability token is being used.",
    ],
  };
}

export function llmsText(request?: Request): string {
  const serviceUrl = resolveServiceUrl(request);
  const acceptableUseUrl = new URL(acceptableUsePath, serviceUrl).toString();

  return `# Agentic Compute Storefront

This service leases one product: a temporary bare Linux machine.

Primary product:
- id: ${product.id}
- OS image: ${product.image}
- provider default: ${product.defaultProvider}
- duration: ${product.minDurationMinutes}-${product.maxDurationMinutes} minutes
- SSH username: ${product.username}
- region: Hetzner EU (${product.location})

Pricing:
- base fee: $${formatCents(Number(process.env.CHECKOUT_BASE_FEE_CENTS ?? 99))}
- minute rate: $${formatCents(Number(process.env.PRICE_CENTS_PER_MINUTE ?? 5))}/minute

Generate a UUID request_id and send it in every body below. It is the idempotency key: reuse the same request_id (with an identical body) across validate, create, and the paid retry. The order_id is derived from it.

Optional preflight (recommended):
POST /api/machine/mpp/orders/validate
Content-Type: application/json
JSON: { "request_id": "<uuid>", "duration_minutes": 60, "ssh_public_key": "ssh-ed25519 ..." }
Returns { protocol, methods, product_type, quote, request_id } with no payment and no machine created. Reuse the same body on create.

Create an order (and machine):
POST /api/machine/mpp/orders
Content-Type: application/json
JSON: { "request_id": "<uuid>", "duration_minutes": 60, "ssh_public_key": "ssh-ed25519 ..." }

Without a payment credential the service responds with HTTP 402, MPP payment challenges (WWW-Authenticate), and { order_id, status: "unpaid" }.
Retry the identical body with a Stripe-backed MPP payment credential.
If that retry still returns 402 with credential_status: "rejected", the credential reached the server but was not accepted yet (often a freshly approved Shared Payment Token that is not chargeable for a few seconds). Read "reason", wait briefly, and retry the same request_id; idempotency guarantees at most one charge. A 402 without credential_status means no credential was attached at all.
After successful payment you receive HTTP 202 with:
- order_id
- status = settled, payment_status = paid, is_paid = true
- current_step
- order_complete_url
- machine

The machine object includes resource-scoped management tokens:
- read_token for GET /api/machines/{machine_id}
- extend_token for POST /api/machines/{machine_id}/extend
- terminate_token for DELETE /api/machines/{machine_id}

Payment client guidance:
- Recommended for agents: Stripe Link CLI MPP SPT.
- Current Link CLI requires an approved spend request before mpp pay.
- Decode the payment challenge first: ${paymentClientGuidance.recommended.command_sequence[0]}
- Create the SPT spend request: ${paymentClientGuidance.recommended.command_sequence[2]}
- Pay the checkout endpoint: ${paymentClientGuidance.recommended.command_sequence[3].replace("{service_url}", serviceUrl)}
- Use a live Stripe SPT. Test-mode Stripe credentials and sandbox payment tokens are not accepted.
- Also supported: any MPP client that can create a Stripe Shared Payment Token for the advertised challenge and retry with Authorization: Payment.
- Do not use Link CLI virtual cards; this API does not expose a standard card checkout form.
- Do not use manual card entry or crypto payment clients; they are not accepted by this storefront.

Poll order payment status (no auth; keyed by order_id):
GET /api/machine/mpp/orders/{order_id}
Returns { order_id, payment_status, is_paid, current_step, order_complete_url }.

Read machine status:
GET /api/machines/{machine_id}
Authorization: Bearer <read_token>

Extend:
POST /api/machines/{machine_id}/extend
Authorization: Bearer <extend_token>
Content-Type: application/json
JSON: { "additional_minutes": 15 }

Terminate:
DELETE /api/machines/{machine_id}
Authorization: Bearer <terminate_token>

Acceptable use:
- Use machines only for lawful, authorized development, automation, testing, debugging, and compute tasks.
${prohibitedUses.map((item) => `- Do not use machines for: ${item}`).join("\n")}
- Full acceptable use policy: ${acceptableUseUrl}

Important:
- Treat all management tokens as secrets.
- Use /api/machine/mpp/orders, not /api/machines, for agent purchases.
- Do not use the unpaid dev endpoint unless the operator explicitly enabled it for local testing.
- Do not retry failed payments blindly.
- Do not expose tokens in logs or chat unless explicitly required.
- Poll until status is active before trying to SSH.
- Terminate the machine when finished.
- Full machine-readable manifest: /.well-known/agent-storefront.json
- OpenAPI spec: /openapi.json
`;
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function openApiDocument(request?: Request) {
  const serviceUrl = resolveServiceUrl(request);

  return {
    openapi: "3.1.0",
    info: {
      title: "Agentic Compute Storefront API",
      version: "0.1.0",
      description: "API for leasing and managing one temporary bare Linux machine product.",
    },
    servers: [{ url: serviceUrl }],
    paths: {
      "/api/health": {
        get: {
          operationId: "health",
          summary: "Check service health.",
          responses: {
            "200": {
              description: "Service health.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Health" },
                },
              },
            },
          },
        },
      },
      "/api/machines": {
        post: {
          operationId: "createMachine",
          summary: "Create a temporary bare Linux machine.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateMachineRequest" },
              },
            },
          },
          responses: {
            "202": {
              description: "Machine lease accepted. The response includes management tokens once, at creation time.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/MachineWithManagement" },
                },
              },
            },
            "400": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/machine/mpp/orders/validate": {
        post: {
          operationId: "validateOrder",
          summary: "Preflight validate an order and return its quote and payment methods.",
          description:
            "Submit the desired lease to confirm it is valid and to read the final quote and accepted payment methods. No payment is composed and no machine is created. Reuse the same body (including request_id) on POST /api/machine/mpp/orders.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateMachineRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "The order is valid. Returns the protocol, accepted payment methods, product type, and quote.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ValidateOrderResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/machine/mpp/orders": {
        post: {
          operationId: "createOrder",
          summary: "Create an MPP order (and machine) after payment.",
          description:
            "Submit the desired lease with a UUID request_id. Without a valid MPP credential the response is HTTP 402 with MPP payment challenges and { order_id, status: 'unpaid' }. Retry the identical body with an MPP payment credential to settle the order and provision the machine. request_id is the idempotency key.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateMachineRequest" },
              },
            },
          },
          responses: {
            "202": {
              description: "Order settled. The response includes the order, payment_status, and machine management tokens.",
              headers: {
                "Payment-Receipt": {
                  description: "MPP payment receipt.",
                  schema: { type: "string" },
                },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/MppOrder" },
                },
              },
            },
            "400": { $ref: "#/components/responses/Error" },
            "402": {
              description:
                "MPP payment required. Inspect WWW-Authenticate headers for payment challenges; body is { order_id, status: 'unpaid' }.",
            },
          },
        },
      },
      "/api/machine/mpp/orders/{order_id}": {
        get: {
          operationId: "getOrder",
          summary: "Poll order payment status by order_id.",
          parameters: [
            {
              name: "order_id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "The order payment/fulfilment status.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/MppOrder" },
                },
              },
            },
            "404": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/machines/{machine_id}": {
        get: {
          operationId: "getMachine",
          summary: "Read machine status using the read capability token.",
          security: [{ readToken: [] }],
          parameters: [{ $ref: "#/components/parameters/MachineId" }],
          responses: {
            "200": {
              description: "Machine status.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Machine" },
                },
              },
            },
            "401": { $ref: "#/components/responses/Error" },
            "403": { $ref: "#/components/responses/Error" },
            "404": { $ref: "#/components/responses/Error" },
          },
        },
        delete: {
          operationId: "terminateMachine",
          summary: "Terminate a machine using the terminate capability token.",
          security: [{ terminateToken: [] }],
          parameters: [{ $ref: "#/components/parameters/MachineId" }],
          responses: {
            "200": {
              description: "Terminated machine status.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Machine" },
                },
              },
            },
            "401": { $ref: "#/components/responses/Error" },
            "403": { $ref: "#/components/responses/Error" },
            "404": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/machines/{machine_id}/extend": {
        post: {
          operationId: "extendMachine",
          summary: "Extend a machine lease using the extend capability token.",
          security: [{ extendToken: [] }],
          parameters: [{ $ref: "#/components/parameters/MachineId" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ExtendMachineRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Extended machine status.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Machine" },
                },
              },
            },
            "400": { $ref: "#/components/responses/Error" },
            "401": { $ref: "#/components/responses/Error" },
            "403": { $ref: "#/components/responses/Error" },
            "404": { $ref: "#/components/responses/Error" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        readToken: { type: "http", scheme: "bearer", description: "Lease read_token." },
        extendToken: { type: "http", scheme: "bearer", description: "Lease extend_token." },
        terminateToken: { type: "http", scheme: "bearer", description: "Lease terminate_token." },
      },
      parameters: {
        MachineId: {
          name: "machine_id",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^machine_[a-f0-9]{16}$" },
        },
      },
      responses: {
        Error: {
          description: "Error response.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
      schemas: {
        Health: {
          type: "object",
          required: ["status", "product"],
          properties: {
            status: { type: "string", const: "ok" },
            product: { type: "string", const: product.id },
          },
        },
        CreateMachineRequest: {
          type: "object",
          required: ["request_id", "duration_minutes", "ssh_public_key"],
          additionalProperties: false,
          properties: {
            request_id: {
              type: "string",
              format: "uuid",
              description:
                "Idempotency key (UUID). Reuse the same value across validate, create, and the paid retry (with an otherwise identical body) so the same order resolves to the same payment challenge and order_id.",
              pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            },
            duration_minutes: {
              type: "integer",
              minimum: product.minDurationMinutes,
              maximum: product.maxDurationMinutes,
            },
            ssh_public_key: {
              type: "string",
              description: "SSH public key to install on the leased machine.",
            },
          },
        },
        ExtendMachineRequest: {
          type: "object",
          required: ["additional_minutes"],
          additionalProperties: false,
          properties: {
            additional_minutes: {
              type: "integer",
              minimum: 1,
            },
          },
        },
        Machine: {
          type: "object",
          required: ["machine_id", "product", "provider", "status", "host", "username", "created_at", "expires_at"],
          properties: {
            machine_id: { type: "string" },
            product: { type: "string", const: product.id },
            provider: { type: "string" },
            status: {
              type: "string",
              enum: ["provisioning", "active", "terminating", "terminated", "failed"],
            },
            host: { type: ["string", "null"] },
            username: { type: "string" },
            ssh_command: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            expires_at: { type: "string", format: "date-time" },
            terminated_at: { type: "string", format: "date-time" },
            failure_reason: { type: "string" },
          },
        },
        MachineWithManagement: {
          allOf: [
            { $ref: "#/components/schemas/Machine" },
            {
              type: "object",
              required: ["management"],
              properties: {
                management: { $ref: "#/components/schemas/ManagementTokens" },
              },
            },
          ],
        },
        MppOrder: {
          type: "object",
          required: ["order_id", "status", "payment_status", "is_paid", "current_step", "order_complete_url"],
          properties: {
            order_id: { type: "string" },
            status: { type: "string", enum: ["unpaid", "settled", "settled_pending_webhook"] },
            payment_status: { type: "string", enum: ["unpaid", "paid", "settled_pending_webhook"] },
            is_paid: { type: "boolean" },
            current_step: { type: "string" },
            order_complete_url: { type: "string", format: "uri" },
            // Present on the 202 create response (with management tokens) and on
            // the order poll (without tokens). Absent until the order is paid.
            machine: { $ref: "#/components/schemas/MachineWithManagement" },
          },
        },
        CheckoutQuote: {
          type: "object",
          required: [
            "product_id",
            "duration_minutes",
            "base_fee_cents",
            "unit_price_cents_per_minute",
            "amount_cents",
            "amount",
            "currency",
          ],
          properties: {
            product_id: { type: "string", const: product.id },
            duration_minutes: {
              type: "integer",
              minimum: product.minDurationMinutes,
              maximum: product.maxDurationMinutes,
            },
            base_fee_cents: { type: "integer", minimum: 0 },
            unit_price_cents_per_minute: { type: "integer", minimum: 1 },
            amount_cents: { type: "integer", minimum: 1 },
            amount: { type: "string", pattern: "^\\d+\\.\\d{2}$" },
            currency: { type: "string", const: "usd" },
          },
        },
        ValidateOrderResponse: {
          type: "object",
          required: ["protocol", "methods", "product_type", "quote", "request_id"],
          properties: {
            protocol: { type: "string", const: "mpp" },
            methods: { type: "array", items: { type: "string" } },
            product_type: { type: "string", const: "machine_lease" },
            quote: { $ref: "#/components/schemas/CheckoutQuote" },
            request_id: { type: "string", format: "uuid" },
          },
        },
        ManagementTokens: {
          type: "object",
          required: ["read_token", "extend_token", "terminate_token"],
          properties: {
            read_token: { type: "string" },
            extend_token: { type: "string" },
            terminate_token: { type: "string" },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
          },
        },
      },
    },
  };
}
