from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


VALID_STATUSES = {
    "provisioning",
    "active",
    "terminating",
    "terminated",
    "failed",
}


@dataclass(frozen=True)
class CreateMachineRequest:
    duration_minutes: int
    ssh_public_key: str


@dataclass(frozen=True)
class ProvisionedMachine:
    provider_server_id: str
    host: str
    username: str


@dataclass(frozen=True)
class MachineLease:
    id: str
    product_id: str
    provider: str
    provider_server_id: str | None
    status: str
    ssh_public_key: str
    host: str | None
    username: str
    created_at: datetime
    expires_at: datetime
    terminated_at: datetime | None
    failure_reason: str | None

    def to_public_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "machine_id": self.id,
            "product": self.product_id,
            "provider": self.provider,
            "status": self.status,
            "host": self.host,
            "username": self.username,
            "created_at": format_datetime(self.created_at),
            "expires_at": format_datetime(self.expires_at),
        }
        if self.host and self.status == "active":
            body["ssh_command"] = f"ssh {self.username}@{self.host}"
        if self.terminated_at:
            body["terminated_at"] = format_datetime(self.terminated_at)
        if self.failure_reason:
            body["failure_reason"] = self.failure_reason
        return body


def parse_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def format_datetime(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

