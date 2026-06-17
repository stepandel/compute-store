from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod

from storefront.config import Product, Settings
from storefront.models import MachineLease, ProvisionedMachine


class ProviderError(Exception):
    pass


class ComputeProvider(ABC):
    @abstractmethod
    def provision(self, lease: MachineLease) -> ProvisionedMachine:
        raise NotImplementedError

    @abstractmethod
    def terminate(self, lease: MachineLease) -> None:
        raise NotImplementedError


class DryRunProvider(ComputeProvider):
    def provision(self, lease: MachineLease) -> ProvisionedMachine:
        time.sleep(0.05)
        return ProvisionedMachine(
            provider_server_id=f"dryrun-{lease.id}",
            host="203.0.113.10",
            username=lease.username,
        )

    def terminate(self, lease: MachineLease) -> None:
        time.sleep(0.01)


class HetznerProvider(ComputeProvider):
    base_url = "https://api.hetzner.cloud/v1"

    def __init__(self, token: str, product: Product):
        self.token = token
        self.product = product

    def provision(self, lease: MachineLease) -> ProvisionedMachine:
        key_name = f"storefront-{lease.id}"
        ssh_key = self._request(
            "POST",
            "/ssh_keys",
            {
                "name": key_name,
                "public_key": lease.ssh_public_key,
            },
        )["ssh_key"]
        server = self._request(
            "POST",
            "/servers",
            {
                "name": f"lease-{lease.id}",
                "server_type": self.product.server_type,
                "image": self.product.image,
                "location": self.product.location,
                "ssh_keys": [ssh_key["id"]],
                "labels": {
                    "managed_by": "agentic-storefront",
                    "lease_id": lease.id,
                    "product": lease.product_id,
                },
            },
        )["server"]
        ipv4 = server.get("public_net", {}).get("ipv4", {}).get("ip")
        if not ipv4:
            ipv4 = self._wait_for_ipv4(str(server["id"]))
        return ProvisionedMachine(
            provider_server_id=str(server["id"]),
            host=ipv4,
            username=self.product.username,
        )

    def terminate(self, lease: MachineLease) -> None:
        if not lease.provider_server_id:
            return
        try:
            self._request("DELETE", f"/servers/{lease.provider_server_id}")
        except ProviderError as exc:
            if "404" not in str(exc):
                raise

    def _wait_for_ipv4(self, server_id: str) -> str:
        for _ in range(30):
            server = self._request("GET", f"/servers/{server_id}")["server"]
            ipv4 = server.get("public_net", {}).get("ipv4", {}).get("ip")
            if ipv4:
                return ipv4
            time.sleep(2)
        raise ProviderError(f"Timed out waiting for IPv4 address on server {server_id}.")

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={
                "authorization": f"Bearer {self.token}",
                "content-type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
                return json.loads(payload.decode("utf-8")) if payload else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise ProviderError(f"Hetzner API returned {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise ProviderError(f"Hetzner API request failed: {exc}") from exc


def build_provider(settings: Settings) -> ComputeProvider:
    if settings.provider == "dry-run":
        return DryRunProvider()
    if settings.provider == "hetzner":
        if not settings.hetzner_api_token:
            raise ProviderError("HETZNER_API_TOKEN is required when PROVIDER=hetzner.")
        return HetznerProvider(settings.hetzner_api_token, settings.product)
    raise ProviderError(f"Unsupported provider: {settings.provider}")

