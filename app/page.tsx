import { headers } from "next/headers";

import { product } from "@/lib/config";
import { CopyButton } from "./CopyButton";
import { ClaudeLogo, CodexLogo, HermesLogo, OpenClawLogo } from "./logos";

const AGENTS = [
  { name: "Claude", Logo: ClaudeLogo },
  { name: "Codex", Logo: CodexLogo },
  { name: "Hermes", Logo: HermesLogo },
  { name: "OpenClaw", Logo: OpenClawLogo },
] as const;

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function resolveBaseUrl(): Promise<string> {
  if (process.env.NEXT_PUBLIC_STORE_URL) {
    return process.env.NEXT_PUBLIC_STORE_URL.replace(/\/$/, "");
  }
  const h = await headers();
  const host = h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

export default async function Home() {
  const baseUrl = await resolveBaseUrl();
  const baseFee = formatCents(Number(process.env.CHECKOUT_BASE_FEE_CENTS ?? 99));
  const perMinute = formatCents(Number(process.env.PRICE_CENTS_PER_MINUTE ?? 5));

  const agentPrompt = [
    `You have access to an agentic compute storefront at ${baseUrl}.`,
    `It leases temporary bare ${product.image} Linux machines with SSH access, billed per minute.`,
    "",
    `1. Read ${baseUrl}/llms.txt for the full machine-readable instructions.`,
    `2. To buy, POST ${baseUrl}/api/machine/mpp/orders with JSON:`,
    `   {"request_id": "<uuid>", "duration_minutes": 60, "ssh_public_key": "<your ssh public key>"}`,
    "3. You will get an HTTP 402 with an MPP payment challenge. Pay it with the",
    "   Stripe Link CLI (preferred) and retry the same request.",
    "4. On success you receive SSH access plus read, extend, and terminate tokens.",
    "   Treat the tokens as secrets and terminate the machine when you are done.",
  ].join("\n");

  return (
    <main className="shell">
      <div className="page">
        <header className="masthead">
          <p className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            Agentic Compute Storefront
          </p>
          <h1>
            A store that only<br />sells to machines.
          </h1>
        </header>

        {/* Signature: the agent ↔ store handshake that defines this store. */}
        <section className="handshake" aria-label="How an agent buys compute">
          <div className="handshake-rail" aria-hidden="true" />
          <ol className="exchange">
            <li className="from-agent">
              <span className="actor">agent</span>
              <span className="arrow">→</span>
              <code className="msg">POST /api/machine/mpp/orders</code>
              <span className="note">duration + ssh key</span>
            </li>
            <li className="from-store amber-line">
              <span className="actor">store</span>
              <span className="arrow">←</span>
              <code className="msg">402 Payment Required</code>
              <span className="note status-wait">awaiting payment</span>
            </li>
            <li className="from-agent">
              <span className="actor">agent</span>
              <span className="arrow">→</span>
              <code className="msg">pay · Stripe Link · retry</code>
              <span className="note">shared payment token</span>
            </li>
            <li className="from-store ok-line">
              <span className="actor">store</span>
              <span className="arrow">←</span>
              <code className="msg">200 OK · ssh root@host</code>
              <span className="note status-ok">leased</span>
            </li>
          </ol>
          <dl className="terms">
            <div>
              <dt>Lease</dt>
              <dd>
                {product.minDurationMinutes}–{product.maxDurationMinutes} min
              </dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>
                {baseFee} + {perMinute}/min
              </dd>
            </div>
            <div>
              <dt>Image</dt>
              <dd>{product.image}</dd>
            </div>
            <div>
              <dt>Region</dt>
              <dd>{product.location}</dd>
            </div>
          </dl>
        </section>

        <section className="card prompt-card">
          <div className="card-head">
            <h2>Hand this to your agent</h2>
            <CopyButton text={agentPrompt} label="Copy prompt" />
          </div>
          <pre className="prompt">{agentPrompt}</pre>
        </section>

        <section className="card">
          <h2>Compatible agents</h2>
          <ul className="agent-grid">
            {AGENTS.map(({ name, Logo }) => (
              <li key={name} className="agent">
                <span className="agent-logo">
                  <Logo />
                </span>
                <span className="agent-name">{name}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>Payment</h2>
          <p className="muted">
            Virtual cards accepted. Preferred: <strong>Stripe Link</strong> via the <strong>Link CLI</strong>.
          </p>
          <ol className="steps">
            <li>
              <code>POST /api/machine/mpp/orders</code> returns <code>402</code>.
            </li>
            <li>
              Create an approved Link CLI spend request (<code>shared_payment_token</code>).
            </li>
            <li>Pay, then retry — the machine provisions.</li>
          </ol>
        </section>

        <section className="card">
          <h2>Machine-readable entry points</h2>
          <ul className="links">
            <li>
              <a href="/llms.txt">/llms.txt</a>
            </li>
            <li>
              <a href="/.well-known/agent-storefront.json">/.well-known/agent-storefront.json</a>
            </li>
            <li>
              <a href="/openapi.json">/openapi.json</a>
            </li>
            <li>
              <a href="/acceptable-use">/acceptable-use</a>
            </li>
          </ul>
        </section>

        <footer className="foot">
          <p>
            Lawful, authorized compute only. See <a href="/acceptable-use">acceptable use</a>.
          </p>
        </footer>
      </div>
    </main>
  );
}
