"use client";

import { FormEvent, useState } from "react";

type PublicMachine = {
  machine_id: string;
  product: string;
  provider: string;
  status: "provisioning" | "active" | "terminating" | "terminated" | "failed";
  host: string | null;
  username: string;
  created_at: string;
  expires_at: string;
  ssh_command?: string;
  terminated_at?: string;
  failure_reason?: string;
  management?: ManagementTokens;
};

type ManagementTokens = {
  read_token: string;
  extend_token: string;
  terminate_token: string;
};

type CheckoutResponse = {
  checkout: {
    status: "paid";
    mode?: "mpp" | "stripe_sandbox_autopay";
    quote: {
      amount: string;
      currency: "usd";
      base_fee_cents: number;
      duration_minutes: number;
      unit_price_cents_per_minute: number;
    };
    stripe?: {
      payment_intent_id?: string;
    };
  };
  machine: PublicMachine;
};

export default function Home() {
  const [duration, setDuration] = useState("60");
  const [sshKey, setSshKey] = useState("");
  const [machineId, setMachineId] = useState("");
  const [readToken, setReadToken] = useState("");
  const [extendToken, setExtendToken] = useState("");
  const [terminateToken, setTerminateToken] = useState("");
  const [extendMinutes, setExtendMinutes] = useState("15");
  const [machine, setMachine] = useState<PublicMachine | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function checkoutMachine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          duration_minutes: Number(duration),
          ssh_public_key: sshKey,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setMessage(
          response.status === 402
            ? "Payment required. Retry this checkout request with an MPP payment credential."
            : errorMessage(payload, "Checkout failed."),
        );
        return;
      }
      const checkout = payload as CheckoutResponse;
      setMachine(checkout.machine);
      setMachineId(checkout.machine.machine_id);
      if (checkout.machine.management) {
        setReadToken(checkout.machine.management.read_token);
        setExtendToken(checkout.machine.management.extend_token);
        setTerminateToken(checkout.machine.management.terminate_token);
      }
    } finally {
      setBusy(false);
    }
  }

  async function refreshMachine(id = machineId) {
    if (!id) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/machines/${id}`, {
        headers: bearerHeaders(readToken),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error ?? "Machine not found.");
        return;
      }
      setMachine(payload);
      setMachineId(payload.machine_id);
    } finally {
      setBusy(false);
    }
  }

  async function terminateMachine() {
    if (!machine?.machine_id) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/machines/${machine.machine_id}`, {
        method: "DELETE",
        headers: bearerHeaders(terminateToken),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error ?? "Terminate failed.");
        return;
      }
      setMachine(payload);
    } finally {
      setBusy(false);
    }
  }

  async function extendMachine() {
    if (!machine?.machine_id) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/machines/${machine.machine_id}/extend`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bearerHeaders(extendToken),
        },
        body: JSON.stringify({ additional_minutes: Number(extendMinutes) }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error ?? "Extend failed.");
        return;
      }
      setMachine(payload);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="workbench">
        <div className="intro">
          <p className="eyebrow">Compute Storefront</p>
          <h1>Bare Linux Machine Checkout</h1>
        </div>

        <form className="machine-form" onSubmit={checkoutMachine}>
          <label>
            <span>Duration</span>
            <div className="duration-row">
              <input
                min="15"
                max="360"
                step="15"
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
                type="number"
              />
              <span>minutes</span>
            </div>
          </label>

          <label>
            <span>SSH public key</span>
            <textarea
              value={sshKey}
              onChange={(event) => setSshKey(event.target.value)}
              placeholder="ssh-ed25519 AAAA..."
              rows={5}
            />
          </label>

          <div className="actions">
            <button disabled={busy} type="submit">
              Start MPP Checkout
            </button>
            <button disabled={busy || !machineId} onClick={() => refreshMachine()} type="button" className="secondary">
              Refresh
            </button>
          </div>

          <p className="policy-note">
            Checkout is for lawful, authorized compute only. Abuse, scanning, spam, malware, mining, and evasion are not
            allowed. See <a href="/acceptable-use">acceptable use</a>.
          </p>
        </form>

        <div className="lookup">
          <label>
            <span>Machine ID</span>
            <input value={machineId} onChange={(event) => setMachineId(event.target.value)} />
          </label>
          <button disabled={busy || !machineId} onClick={() => refreshMachine()} type="button" className="secondary">
            Load
          </button>
        </div>

        <div className="token-grid">
          <label>
            <span>Read token</span>
            <input value={readToken} onChange={(event) => setReadToken(event.target.value)} />
          </label>
          <label>
            <span>Extend token</span>
            <input value={extendToken} onChange={(event) => setExtendToken(event.target.value)} />
          </label>
          <label>
            <span>Terminate token</span>
            <input value={terminateToken} onChange={(event) => setTerminateToken(event.target.value)} />
          </label>
        </div>

        {message ? <p className="message">{message}</p> : null}

        {machine ? (
          <section className="status-panel">
            <div>
              <p className="eyebrow">Lease</p>
              <h2>{machine.machine_id}</h2>
            </div>
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={`status ${machine.status}`}>{machine.status}</span>
                </dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{machine.provider}</dd>
              </div>
              <div>
                <dt>Host</dt>
                <dd>{machine.host ?? "pending"}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{formatDate(machine.expires_at)}</dd>
              </div>
            </dl>

            {machine.ssh_command ? <code className="ssh-command">{machine.ssh_command}</code> : null}
            {machine.failure_reason ? <p className="message">{machine.failure_reason}</p> : null}

            <div className="actions">
              <button disabled={busy} onClick={() => refreshMachine(machine.machine_id)} type="button" className="secondary">
                Refresh
              </button>
              <div className="extend-action">
                <input
                  min="1"
                  max="360"
                  value={extendMinutes}
                  onChange={(event) => setExtendMinutes(event.target.value)}
                  type="number"
                />
                <button
                  disabled={busy || machine.status === "terminated" || machine.status === "failed"}
                  onClick={extendMachine}
                  type="button"
                  className="secondary"
                >
                  Extend
                </button>
              </div>
              <button
                disabled={busy || machine.status === "terminated" || machine.status === "failed"}
                onClick={terminateMachine}
                type="button"
                className="danger"
              >
                Terminate
              </button>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}

function bearerHeaders(token: string): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function errorMessage(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.error === "string" ? payload.error : fallback;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
