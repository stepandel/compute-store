# Agentic Compute Storefront

A small Next.js + TypeScript storefront for leasing one product: a temporary bare Linux machine.

The app is intentionally narrow:

- One product: `bare-linux-machine`
- One request shape: duration plus SSH public key
- One paid checkout flow: MPP `402 Payment Required`, then provision after payment
- One lifecycle: create, poll, extend, terminate, expire
- Resource-scoped lease capability tokens for management
- One local persistence layer: JSON file storage
- One safe default provider: dry-run, which simulates provisioning
- Optional real provider: Hetzner Cloud, enabled explicitly with env vars

## Run

```bash
bun install
bun run dev
```

Open `http://localhost:3000`.

Useful env vars:

```bash
DATA_PATH=data/machines.json
LEASE_STORE=file
PROVIDER=dry-run
ALLOW_UNPAID_MACHINE_CREATE=false
CRON_SECRET=replace-with-random-secret
MPP_SECRET_KEY=replace-with-random-base64-secret
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PROFILE_ID=profile_...
STRIPE_PAYMENT_METHOD_TYPES=card,link
CHECKOUT_BASE_FEE_CENTS=99
PRICE_CENTS_PER_MINUTE=5
```

For Vercel or any serverless deployment that provisions real infrastructure, use durable storage instead of the local JSON file:

```bash
LEASE_STORE=redis-rest
REDIS_REST_URL=https://...
REDIS_REST_TOKEN=...
REDIS_REST_KEY=checkout-proto:leases
```

`LEASE_STORE=file` is for local development and tests. The app refuses to run real providers in `NODE_ENV=production` with the file store because Vercel function filesystems are not durable application storage.

Generate `MPP_SECRET_KEY` with:

```bash
openssl rand -base64 32
```

Paid checkout is exposed at `POST /api/machine/mpp/orders`, modeled on PostalForm's machine MPP endpoints. Submit the order details with a UUID `request_id`, receive an HTTP `402` payment challenge (plus `{ order_id, status: "unpaid" }`) if no credential is present, retry the identical body with a live Stripe-backed MPP payment credential, and then receive the settled order and fulfilled machine. A preflight `POST /api/machine/mpp/orders/validate` returns the quote and accepted methods without composing payment, and `GET /api/machine/mpp/orders/{order_id}` polls payment status.

`request_id` is the idempotency key: reuse the same UUID (with an otherwise identical body) across validate, create, and the paid retry. It deterministically derives `order_id`, so a retried paid call resolves to the existing lease instead of provisioning a second machine.

For Stripe SPT/card-style MPP payments, create a live Stripe profile in the Dashboard and set `STRIPE_PROFILE_ID` to the `profile_...` value. Use a matching live `STRIPE_SECRET_KEY=sk_live_...`. Test-mode Stripe keys and sandbox payment tokens are rejected by production checkout. The default accepted SPT-backed payment methods are `card,link`.

Recommended agent payment path is Stripe Link CLI using an MPP Shared Payment Token. Current Link CLI versions require the agent to decode the `402` challenge, create an approved spend request, then pay the endpoint:

```bash
npx @stripe/link-cli mpp decode \
  --challenge '<WWW-Authenticate Payment challenge>'

npx @stripe/link-cli payment-methods list

npx @stripe/link-cli spend-request create \
  --payment-method-id <payment_method_id> \
  --credential-type shared_payment_token \
  --network-id <network_id_from_challenge> \
  --amount 399 \
  --currency usd \
  --context "Checkout a 60 minute bare Linux machine lease on behalf of the owner. The lease is temporary, costs $3.99, and will be terminated when the task is complete." \
  --line-item "name:60 minute bare Linux machine lease,unit_amount:399,quantity:1" \
  --total "type:total,display_text:Total,amount:399" \
  --request-approval

npx @stripe/link-cli mpp pay http://localhost:3000/api/machine/mpp/orders \
  --spend-request-id <approved_spend_request_id> \
  --method POST \
  --header 'Content-Type: application/json' \
  --data '{"request_id":"<uuid>","duration_minutes":60,"ssh_public_key":"ssh-ed25519 ..."}'
```

Any MPP client that can create a Stripe SPT for the advertised challenge and retry with `Authorization: Payment ...` should work. Link CLI virtual cards and manual card entry are not supported because this storefront exposes an agentic MPP endpoint, not a browser card checkout form. Crypto MPP is intentionally not accepted.

Checkout is subject to [acceptable use](ACCEPTABLE_USE.md), also served for live agents at `/acceptable-use`. Machines are for lawful, authorized development, automation, testing, debugging, and compute tasks. Do not use leased machines for spam, phishing, unauthorized scanning or exploitation, denial-of-service activity, malware, botnets, cryptojacking, cryptocurrency mining, illegal content, sanctions evasion, or platform safety bypasses.

To use Hetzner for real provisioning:

```bash
PROVIDER=hetzner
HETZNER_API_TOKEN=...
LEASE_STORE=redis-rest
REDIS_REST_URL=...
REDIS_REST_TOKEN=...
bun run dev
```

The Hetzner adapter is configured for a small EU Ubuntu machine:

- Server type: `cx23`
- Image: `ubuntu-24.04`
- Location: `fsn1` in Falkenstein, Germany
- Access: the provided SSH public key is attached at provision time
- Network hardening: each lease gets a Hetzner Cloud Firewall allowing inbound TCP/22 from IPv4/IPv6 and denying other inbound traffic

Provisioning is completed before checkout returns. If Hetzner creation fails after a partial resource was created, the app attempts to clean up the server, SSH key, and firewall before marking the lease failed.

## API

Agent discovery:

```bash
curl -s http://localhost:3000/llms.txt
curl -s http://localhost:3000/.well-known/agent-storefront.json
curl -s http://localhost:3000/openapi.json
```

Preflight (optional) — quote and accepted methods, no payment:

```bash
curl -s http://localhost:3000/api/machine/mpp/orders/validate \
  -H 'content-type: application/json' \
  -d '{
    "request_id": "11111111-1111-4111-8111-111111111111",
    "duration_minutes": 60,
    "ssh_public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example"
  }'
```

Create an order (and machine):

```bash
curl -i http://localhost:3000/api/machine/mpp/orders \
  -H 'content-type: application/json' \
  -d '{
    "request_id": "11111111-1111-4111-8111-111111111111",
    "duration_minutes": 60,
    "ssh_public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example"
  }'
```

Without an MPP credential, the response is `402 Payment Required` with `WWW-Authenticate` payment challenges and `{ "order_id": "order_...", "status": "unpaid" }`. Retry the identical body with a valid MPP payment credential to receive:

```json
{
  "order_id": "order_...",
  "status": "settled",
  "payment_status": "paid",
  "is_paid": true,
  "current_step": "provisioning",
  "order_complete_url": "http://localhost:3000/api/machine/mpp/orders/order_...",
  "machine": {
    "machine_id": "machine_...",
    "management": {
      "read_token": "mt_read_...",
      "extend_token": "mt_extend_...",
      "terminate_token": "mt_term_..."
    }
  }
}
```

Poll order payment status (no auth; keyed by `order_id`):

```bash
curl -s http://localhost:3000/api/machine/mpp/orders/<order_id>
```

The unpaid local/dev provisioning endpoint is disabled by default, including in dry-run mode. It is available only when `ALLOW_UNPAID_MACHINE_CREATE=true`:

```bash
curl -s http://localhost:3000/api/machines \
  -H 'content-type: application/json' \
  -d '{
    "duration_minutes": 60,
    "ssh_public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example"
  }'
```

Get machine status:

```bash
curl -s http://localhost:3000/api/machines/<machine_id> \
  -H 'authorization: Bearer <read_token>'
```

Extend a machine:

```bash
curl -X POST -s http://localhost:3000/api/machines/<machine_id>/extend \
  -H 'authorization: Bearer <extend_token>' \
  -H 'content-type: application/json' \
  -d '{"additional_minutes": 15}'
```

Terminate early:

```bash
curl -X DELETE -s http://localhost:3000/api/machines/<machine_id> \
  -H 'authorization: Bearer <terminate_token>'
```

Expire due leases:

```bash
curl -s http://localhost:3000/api/machines/expire \
  -H 'authorization: Bearer <cron_secret>'
```

Health check:

```bash
curl -s http://localhost:3000/api/health
```

## Architecture

```mermaid
flowchart TD
  A["Agent or UI"] --> B["POST /api/machine/mpp/orders"]
  B --> C["Validate request_id + duration + SSH key"]
  C --> P["MPP payment challenge or receipt"]
  P --> D["Create lease in JSON store"]
  D --> E["Provider creates server"]
  E --> F["Store host + provider ids"]
  D --> J["Return read / extend / terminate capability tokens"]
  F --> G["GET /api/machines/:id checks read token"]
  B --> H["Opportunistic expiry"]
  H --> I["Provider terminates expired server"]
```

There is no required resident worker. Expiry runs opportunistically during create/get flows and through `GET /api/machines/expire`, which is scheduled in `vercel.json` as a Vercel Cron job every five minutes.

Vercel Cron invokes the configured path with an HTTP `GET` request and sends `CRON_SECRET` as `Authorization: Bearer <secret>`. Set `CRON_SECRET` in Vercel before deploying. The bundled five-minute cron requires a Vercel plan that supports that frequency; Hobby plans allow only daily cron, so timely real-server expiry needs a paid Vercel plan or a separate external scheduler.

The JSON store is useful for local prototyping. Real Vercel usage should set `LEASE_STORE=redis-rest` and point `REDIS_REST_URL` / `REDIS_REST_TOKEN` at durable Redis-compatible storage.

The agent never receives cloud-provider credentials. It receives only the leased machine host, SSH command, and resource-scoped capability tokens for that lease. Raw tokens are returned once at create time and stored hashed at rest.

Agents should start with `/llms.txt` for terse operating instructions, then use `/.well-known/agent-storefront.json` or `/openapi.json` for machine-readable endpoint details.

## Tests

```bash
bun run typecheck
bun test
bun run build
```
