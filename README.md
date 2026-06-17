# Agentic Compute Storefront Prototype

A minimal storefront API for renting one product: a temporary bare Linux machine.

The prototype is intentionally narrow:

- One product: `bare-linux-machine`
- One request shape: duration plus SSH public key
- One lifecycle: create, poll, terminate, auto-expire
- One persistence layer: SQLite
- One safe default provider: dry-run, which simulates provisioning
- Optional real provider: Hetzner Cloud, enabled explicitly with env vars

## Run

```bash
python3 -m storefront.server
```

The server listens on `http://127.0.0.1:8080` by default.

Useful env vars:

```bash
PORT=8080
DATABASE_PATH=storefront.sqlite3
PROVIDER=dry-run
```

To use Hetzner for real provisioning:

```bash
PROVIDER=hetzner
HETZNER_API_TOKEN=...
python3 -m storefront.server
```

The Hetzner adapter is configured for a small Ubuntu machine:

- Server type: `cx22`
- Image: `ubuntu-24.04`
- Location: `fsn1`
- Access: the provided SSH public key is attached at provision time

The next hardening step is to attach a per-lease firewall that allows inbound SSH and denies other inbound traffic.

## API

Create a machine:

```bash
curl -s http://127.0.0.1:8080/machines \
  -H 'content-type: application/json' \
  -d '{
    "duration_minutes": 60,
    "ssh_public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example"
  }'
```

Get machine status:

```bash
curl -s http://127.0.0.1:8080/machines/<machine_id>
```

Terminate early:

```bash
curl -X DELETE -s http://127.0.0.1:8080/machines/<machine_id>
```

Health check:

```bash
curl -s http://127.0.0.1:8080/health
```

## Architecture

```mermaid
flowchart TD
  A["Agent"] --> B["POST /machines"]
  B --> C["Validate duration + SSH key"]
  C --> D["Create lease in SQLite"]
  D --> E["Provider creates server"]
  E --> F["Store host + provider id"]
  F --> G["GET /machines/:id returns access info"]
  D --> H["Expiry worker"]
  H --> I["Provider terminates expired server"]
```

The agent never receives cloud-provider credentials. It only receives the leased machine host and SSH command.

## Tests

```bash
python3 -m unittest
```
