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
};

export default function Home() {
  const [duration, setDuration] = useState("60");
  const [sshKey, setSshKey] = useState("");
  const [machineId, setMachineId] = useState("");
  const [machine, setMachine] = useState<PublicMachine | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function createMachine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      const response = await fetch("/api/machines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          duration_minutes: Number(duration),
          ssh_public_key: sshKey,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error ?? "Request failed.");
        return;
      }
      setMachine(payload);
      setMachineId(payload.machine_id);
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
      const response = await fetch(`/api/machines/${id}`);
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
      const response = await fetch(`/api/machines/${machine.machine_id}`, { method: "DELETE" });
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

  return (
    <main className="shell">
      <section className="workbench">
        <div className="intro">
          <p className="eyebrow">Compute Storefront</p>
          <h1>Bare Linux Machine</h1>
        </div>

        <form className="machine-form" onSubmit={createMachine}>
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
              Create Machine
            </button>
            <button disabled={busy || !machineId} onClick={() => refreshMachine()} type="button" className="secondary">
              Refresh
            </button>
          </div>
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

