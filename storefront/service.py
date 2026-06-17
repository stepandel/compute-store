from __future__ import annotations

import threading
import uuid
from datetime import datetime, timedelta, timezone

from storefront.config import Product
from storefront.models import CreateMachineRequest, MachineLease
from storefront.providers import ComputeProvider
from storefront.store import LeaseStore


class MachineService:
    def __init__(self, store: LeaseStore, provider: ComputeProvider, product: Product, provider_name: str):
        self.store = store
        self.provider = provider
        self.product = product
        self.provider_name = provider_name

    def create_machine(self, request: CreateMachineRequest) -> MachineLease:
        now = datetime.now(timezone.utc)
        lease = MachineLease(
            id=f"machine_{uuid.uuid4().hex[:16]}",
            product_id=self.product.id,
            provider=self.provider_name,
            provider_server_id=None,
            status="provisioning",
            ssh_public_key=request.ssh_public_key,
            host=None,
            username=self.product.username,
            created_at=now,
            expires_at=now + timedelta(minutes=request.duration_minutes),
            terminated_at=None,
            failure_reason=None,
        )
        self.store.create(lease)
        thread = threading.Thread(target=self._provision, args=(lease.id,), daemon=True)
        thread.start()
        return lease

    def get_machine(self, lease_id: str) -> MachineLease | None:
        return self.store.get(lease_id)

    def terminate_machine(self, lease_id: str) -> MachineLease | None:
        lease = self.store.mark_terminating(lease_id)
        if lease is None:
            return None
        if lease.status == "terminated":
            return self.store.get(lease_id)
        try:
            self.provider.terminate(lease)
            self.store.mark_terminated(lease_id)
        except Exception as exc:
            self.store.mark_failed(lease_id, str(exc))
        return self.store.get(lease_id)

    def expire_due_machines(self) -> int:
        expired = list(self.store.expired_active_leases(datetime.now(timezone.utc)))
        for lease in expired:
            self.terminate_machine(lease.id)
        return len(expired)

    def _provision(self, lease_id: str) -> None:
        lease = self.store.get(lease_id)
        if lease is None:
            return
        try:
            machine = self.provider.provision(lease)
            fresh_lease = self.store.get(lease_id)
            if fresh_lease and fresh_lease.status == "terminating":
                self.provider.terminate(
                    MachineLease(
                        **{
                            **fresh_lease.__dict__,
                            "provider_server_id": machine.provider_server_id,
                            "host": machine.host,
                            "username": machine.username,
                        }
                    )
                )
                self.store.mark_terminated(lease_id)
                return
            self.store.mark_active(lease_id, machine.provider_server_id, machine.host, machine.username)
        except Exception as exc:
            self.store.mark_failed(lease_id, str(exc))
