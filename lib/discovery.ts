import { product } from "@/lib/config";

const serviceUrl = process.env.NEXT_PUBLIC_STORE_URL ?? "http://localhost:3000";

export function agentStorefrontManifest() {
  return {
    name: "Agentic Compute Storefront",
    description: "Lease a temporary bare Linux machine with SSH access and resource-scoped management tokens.",
    version: "0.1.0",
    service_url: serviceUrl,
    llms_txt_url: "/llms.txt",
    openapi_url: "/openapi.json",
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
      checkout_path: "/api/checkout",
      challenge_status: 402,
      methods: ["stripe-spt", "tempo-usdc"],
      pricing: {
        currency: "usd",
        unit_amount_cents_per_minute: Number(process.env.PRICE_CENTS_PER_MINUTE ?? 5),
      },
    },
    endpoints: {
      checkout: {
        method: "POST",
        path: "/api/checkout",
        auth: "MPP payment",
      },
      create_dev: {
        method: "POST",
        path: "/api/machines",
        auth: "none",
        summary: "Unpaid local/dev provisioning path. Use checkout for paid agent purchases.",
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
      "Poll with the read token until status is active before using SSH.",
      "Use the extend token only if more time is required and the lease is still useful.",
      "Use the terminate token as soon as the machine is no longer needed.",
      "If a request fails with 401 or 403, do not retry blindly; verify the correct capability token is being used.",
    ],
  };
}

export function llmsText(): string {
  return `# Agentic Compute Storefront

This service leases one product: a temporary bare Linux machine.

Primary product:
- id: ${product.id}
- OS image: ${product.image}
- provider default: ${product.defaultProvider}
- duration: ${product.minDurationMinutes}-${product.maxDurationMinutes} minutes
- SSH username: ${product.username}

Create a machine:
POST /api/checkout
Content-Type: application/json
JSON: { "duration_minutes": 60, "ssh_public_key": "ssh-ed25519 ..." }

If payment is required, the service responds with HTTP 402 and MPP payment challenges.
Retry the same request with an MPP payment credential. After successful payment, the response includes:
- checkout.status = paid
- checkout.quote
- machine

The machine object includes resource-scoped management tokens:
- read_token for GET /api/machines/{machine_id}
- extend_token for POST /api/machines/{machine_id}/extend
- terminate_token for DELETE /api/machines/{machine_id}

Read status:
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

Important:
- Treat all management tokens as secrets.
- Use /api/checkout, not /api/machines, for paid agent purchases.
- Do not expose tokens in logs or chat unless explicitly required.
- Poll until status is active before trying to SSH.
- Terminate the machine when finished.
- Full machine-readable manifest: /.well-known/agent-storefront.json
- OpenAPI spec: /openapi.json
`;
}

export function openApiDocument() {
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
      "/api/checkout": {
        post: {
          operationId: "checkoutMachine",
          summary: "Create a temporary bare Linux machine after MPP payment.",
          description:
            "Submit the desired lease. If no valid MPP credential is present, the response is HTTP 402 with MPP payment challenges. Retry the same request with an MPP payment credential to provision the machine.",
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
              description: "Paid checkout accepted. The response includes the quote and machine management tokens.",
              headers: {
                "Payment-Receipt": {
                  description: "MPP payment receipt.",
                  schema: { type: "string" },
                },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CheckoutMachineResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/Error" },
            "402": {
              description: "MPP payment required. Inspect WWW-Authenticate headers for payment challenges.",
            },
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
          required: ["duration_minutes", "ssh_public_key"],
          additionalProperties: false,
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
        CheckoutMachineResponse: {
          type: "object",
          required: ["checkout", "machine"],
          properties: {
            checkout: {
              type: "object",
              required: ["status", "quote"],
              properties: {
                status: { type: "string", const: "paid" },
                quote: { $ref: "#/components/schemas/CheckoutQuote" },
              },
            },
            machine: { $ref: "#/components/schemas/MachineWithManagement" },
          },
        },
        CheckoutQuote: {
          type: "object",
          required: [
            "product_id",
            "duration_minutes",
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
            unit_price_cents_per_minute: { type: "integer", minimum: 1 },
            amount_cents: { type: "integer", minimum: 1 },
            amount: { type: "string", pattern: "^\\d+\\.\\d{2}$" },
            currency: { type: "string", const: "usd" },
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
