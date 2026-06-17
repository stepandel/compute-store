from __future__ import annotations

import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone

from storefront.config import Product
from storefront.models import CreateMachineRequest, MachineLease
from storefront.providers import DryRunProvider
from storefront.service import MachineService
from storefront.store import LeaseStore
from storefront.validation import ValidationError, parse_create_machine_request


VALID_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey user@example"


class StorefrontTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.NamedTemporaryFile(delete=True)
        self.product = Product()
        self.store = LeaseStore(self.tmp.name)
        self.service = MachineService(self.store, DryRunProvider(), self.product, "dry-run")

    def tearDown(self) -> None:
        self.tmp.close()

    def test_validates_single_product_request(self) -> None:
        request = parse_create_machine_request(
            {"duration_minutes": 60, "ssh_public_key": VALID_KEY},
            self.product,
        )

        self.assertEqual(request.duration_minutes, 60)
        self.assertEqual(request.ssh_public_key, VALID_KEY)

    def test_rejects_duration_outside_policy(self) -> None:
        with self.assertRaises(ValidationError):
            parse_create_machine_request(
                {"duration_minutes": 1, "ssh_public_key": VALID_KEY},
                self.product,
            )

    def test_create_machine_eventually_becomes_active(self) -> None:
        lease = self.service.create_machine(CreateMachineRequest(60, VALID_KEY))

        self.assertEqual(lease.status, "provisioning")
        for _ in range(20):
            stored = self.service.get_machine(lease.id)
            if stored and stored.status == "active":
                break
            time.sleep(0.02)

        stored = self.service.get_machine(lease.id)
        self.assertIsNotNone(stored)
        assert stored is not None
        self.assertEqual(stored.status, "active")
        self.assertEqual(stored.host, "203.0.113.10")
        self.assertEqual(stored.to_public_dict()["ssh_command"], "ssh root@203.0.113.10")

    def test_terminate_machine_marks_lease_terminated(self) -> None:
        lease = self.service.create_machine(CreateMachineRequest(60, VALID_KEY))
        time.sleep(0.1)

        terminated = self.service.terminate_machine(lease.id)

        self.assertIsNotNone(terminated)
        assert terminated is not None
        self.assertEqual(terminated.status, "terminated")
        self.assertIsNotNone(terminated.terminated_at)

    def test_expiry_worker_terminates_expired_leases(self) -> None:
        now = datetime.now(timezone.utc)
        lease = MachineLease(
            id="machine_expired",
            product_id=self.product.id,
            provider=self.product.provider,
            provider_server_id="dryrun-machine_expired",
            status="active",
            ssh_public_key=VALID_KEY,
            host="203.0.113.10",
            username="root",
            created_at=now - timedelta(hours=2),
            expires_at=now - timedelta(hours=1),
            terminated_at=None,
            failure_reason=None,
        )
        self.store.create(lease)

        count = self.service.expire_due_machines()
        stored = self.service.get_machine(lease.id)

        self.assertEqual(count, 1)
        self.assertIsNotNone(stored)
        assert stored is not None
        self.assertEqual(stored.status, "terminated")


if __name__ == "__main__":
    unittest.main()
