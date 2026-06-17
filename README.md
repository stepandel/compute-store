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
npm install
npm run dev
```

Open `http://localhost:3000`.

Useful env vars:

```bash
DATA_PATH=data/machines.json
PROVIDER=dry-run
CRON_SECRET=replace-with-random-secret
MPP_SECRET_KEY=replace-with-random-base64-secret
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PROFILE_ID=profile_test_...
STRIPE_PAYMENT_METHOD_TYPES=card,link
PRICE_CENTS_PER_MINUTE=5
```

Generate `MPP_SECRET_KEY` with:

```bash
openssl rand -base64 32
```

Paid checkout is exposed at `POST /api/checkout`. It follows the MPP pattern used by agentic checkout examples such as PostalForm and Prospect Butcher Co.: submit the order details, receive an HTTP `402` payment challenge if no credential is present, retry with an MPP payment credential, and then receive the fulfilled resource.

For Stripe SPT/card-style MPP payments, create a Stripe profile in the Dashboard and set `STRIPE_PROFILE_ID` to the `profile_test_...` or `profile_...` value. The default accepted SPT-backed payment methods are `card,link`.

Tempo USDC MPP payments are optional. Set `TEMPO_RECIPIENT_ADDRESS=0x...` to advertise a Tempo challenge as well. `TEMPO_TESTNET=true` is the default for local development.

To use Hetzner for real provisioning:

```bash
PROVIDER=hetzner
HETZNER_API_TOKEN=...
npm run dev
```

The Hetzner adapter is configured for a small Ubuntu machine:

- Server type: `cx22`
- Image: `ubuntu-24.04`
- Location: `fsn1`
- Access: the provided SSH public key is attached at provision time

The next hardening step is to attach a per-lease firewall that allows inbound SSH and denies other inbound traffic.

## API

Agent discovery:

```bash
curl -s http://localhost:3000/llms.txt
curl -s http://localhost:3000/.well-known/agent-storefront.json
curl -s http://localhost:3000/openapi.json
```

Paid checkout for a machine:

```bash
curl -i http://localhost:3000/api/checkout \
  -H 'content-type: application/json' \
  -d '{
    "duration_minutes": 60,
    "ssh_public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example"
  }'
```

Without an MPP credential, the response is `402 Payment Required` with `WWW-Authenticate` payment challenges. Retry the same request with a valid MPP payment credential to receive:

```json
{
  "checkout": {
    "status": "paid",
    "quote": {
      "product_id": "bare-linux-machine",
      "duration_minutes": 60,
      "unit_price_cents_per_minute": 5,
      "amount_cents": 300,
      "amount": "3.00",
      "currency": "usd"
    }
  },
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

The unpaid local/dev provisioning endpoint remains available:

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
  A["Agent or UI"] --> B["POST /api/checkout"]
  B --> C["Validate duration + SSH key"]
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

Vercel Cron invokes the configured path with an HTTP `GET` request and sends `CRON_SECRET` as `Authorization: Bearer <secret>`. Set `CRON_SECRET` in Vercel before deploying. Hobby plans currently allow cron jobs only once per day, so timely lease expiry needs a paid plan or a different scheduler.

The JSON store is useful for local prototyping. Before real Vercel production usage, move leases and capability token hashes to durable storage such as Postgres, Redis, or Vercel KV.

The agent never receives cloud-provider credentials. It receives only the leased machine host, SSH command, and resource-scoped capability tokens for that lease. Raw tokens are returned once at create time and stored hashed at rest.

Agents should start with `/llms.txt` for terse operating instructions, then use `/.well-known/agent-storefront.json` or `/openapi.json` for machine-readable endpoint details.

## Tests

```bash
npm run typecheck
npm test
npm run build
```
