from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    id: str = "bare-linux-machine"
    provider: str = "hetzner"
    server_type: str = "cx22"
    image: str = "ubuntu-24.04"
    location: str = "fsn1"
    username: str = "root"
    min_duration_minutes: int = 15
    max_duration_minutes: int = 360


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    database_path: str
    provider: str
    hetzner_api_token: str | None
    product: Product


def load_settings() -> Settings:
    return Settings(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8080")),
        database_path=os.environ.get("DATABASE_PATH", "storefront.sqlite3"),
        provider=os.environ.get("PROVIDER", "dry-run"),
        hetzner_api_token=os.environ.get("HETZNER_API_TOKEN"),
        product=Product(),
    )

