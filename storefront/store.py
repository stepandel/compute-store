from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from storefront.models import MachineLease, format_datetime, parse_datetime


class LeaseStore:
    def __init__(self, database_path: str):
        self.database_path = database_path
        if database_path != ":memory:":
            Path(database_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.database_path, detect_types=sqlite3.PARSE_DECLTYPES)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS machine_leases (
                    id TEXT PRIMARY KEY,
                    product_id TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    provider_server_id TEXT,
                    status TEXT NOT NULL,
                    ssh_public_key TEXT NOT NULL,
                    host TEXT,
                    username TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    terminated_at TEXT,
                    failure_reason TEXT
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_machine_leases_status_expiry ON machine_leases(status, expires_at)"
            )

    def create(self, lease: MachineLease) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO machine_leases (
                    id, product_id, provider, provider_server_id, status,
                    ssh_public_key, host, username, created_at, expires_at,
                    terminated_at, failure_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lease.id,
                    lease.product_id,
                    lease.provider,
                    lease.provider_server_id,
                    lease.status,
                    lease.ssh_public_key,
                    lease.host,
                    lease.username,
                    format_datetime(lease.created_at),
                    format_datetime(lease.expires_at),
                    format_datetime(lease.terminated_at) if lease.terminated_at else None,
                    lease.failure_reason,
                ),
            )

    def get(self, lease_id: str) -> MachineLease | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM machine_leases WHERE id = ?", (lease_id,)).fetchone()
        return self._row_to_lease(row) if row else None

    def mark_active(self, lease_id: str, provider_server_id: str, host: str, username: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE machine_leases
                SET status = 'active', provider_server_id = ?, host = ?, username = ?, failure_reason = NULL
                WHERE id = ?
                """,
                (provider_server_id, host, username, lease_id),
            )

    def mark_failed(self, lease_id: str, reason: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE machine_leases SET status = 'failed', failure_reason = ? WHERE id = ?",
                (reason, lease_id),
            )

    def mark_terminating(self, lease_id: str) -> MachineLease | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM machine_leases WHERE id = ?", (lease_id,)).fetchone()
            if row is None:
                return None
            lease = self._row_to_lease(row)
            if lease.status in {"terminated", "terminating", "failed"}:
                return lease
            conn.execute("UPDATE machine_leases SET status = 'terminating' WHERE id = ?", (lease_id,))
            return lease

    def mark_terminated(self, lease_id: str) -> None:
        now = format_datetime(datetime.now(timezone.utc))
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE machine_leases
                SET status = 'terminated', terminated_at = ?
                WHERE id = ?
                """,
                (now, lease_id),
            )

    def expired_active_leases(self, now: datetime) -> Iterable[MachineLease]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM machine_leases
                WHERE status IN ('active', 'provisioning') AND expires_at <= ?
                ORDER BY expires_at ASC
                """,
                (format_datetime(now),),
            ).fetchall()
        return [self._row_to_lease(row) for row in rows]

    def _row_to_lease(self, row: sqlite3.Row) -> MachineLease:
        created_at = parse_datetime(row["created_at"])
        expires_at = parse_datetime(row["expires_at"])
        terminated_at = parse_datetime(row["terminated_at"])
        if created_at is None or expires_at is None:
            raise ValueError("Lease row is missing required timestamps.")
        return MachineLease(
            id=row["id"],
            product_id=row["product_id"],
            provider=row["provider"],
            provider_server_id=row["provider_server_id"],
            status=row["status"],
            ssh_public_key=row["ssh_public_key"],
            host=row["host"],
            username=row["username"],
            created_at=created_at,
            expires_at=expires_at,
            terminated_at=terminated_at,
            failure_reason=row["failure_reason"],
        )

