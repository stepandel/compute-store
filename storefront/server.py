from __future__ import annotations

import json
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from storefront.config import load_settings
from storefront.providers import ProviderError, build_provider
from storefront.service import MachineService
from storefront.store import LeaseStore
from storefront.validation import ValidationError, parse_create_machine_request


class StorefrontHandler(BaseHTTPRequestHandler):
    service: MachineService

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok", "product": self.service.product.id})
            return
        machine_id = self._machine_id(path)
        if machine_id:
            lease = self.service.get_machine(machine_id)
            if lease is None:
                self._json(HTTPStatus.NOT_FOUND, {"error": "Machine not found."})
                return
            self._json(HTTPStatus.OK, lease.to_public_dict())
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "Route not found."})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/machines":
            self._json(HTTPStatus.NOT_FOUND, {"error": "Route not found."})
            return
        try:
            payload = self._read_json()
            request = parse_create_machine_request(payload, self.service.product)
            lease = self.service.create_machine(request)
        except ValidationError as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        except json.JSONDecodeError:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Request body must be valid JSON."})
            return
        self._json(HTTPStatus.ACCEPTED, lease.to_public_dict())

    def do_DELETE(self) -> None:
        machine_id = self._machine_id(urlparse(self.path).path)
        if not machine_id:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Route not found."})
            return
        lease = self.service.terminate_machine(machine_id)
        if lease is None:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Machine not found."})
            return
        self._json(HTTPStatus.OK, lease.to_public_dict())

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _machine_id(self, path: str) -> str | None:
        parts = [part for part in path.split("/") if part]
        if len(parts) == 2 and parts[0] == "machines":
            return parts[1]
        return None

    def _read_json(self) -> Any:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        payload = json.dumps(body, indent=2).encode("utf-8")
        self.send_response(status.value)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def start_expiry_worker(service: MachineService, interval_seconds: int = 30) -> threading.Thread:
    def run() -> None:
        while True:
            service.expire_due_machines()
            time.sleep(interval_seconds)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def build_server() -> ThreadingHTTPServer:
    settings = load_settings()
    store = LeaseStore(settings.database_path)
    provider = build_provider(settings)
    service = MachineService(store, provider, settings.product, settings.provider)
    StorefrontHandler.service = service
    server = ThreadingHTTPServer((settings.host, settings.port), StorefrontHandler)
    return server


def main() -> None:
    try:
        server = build_server()
    except ProviderError as exc:
        raise SystemExit(str(exc)) from exc
    start_expiry_worker(StorefrontHandler.service)
    host, port = server.server_address
    print(f"Storefront listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
