from __future__ import annotations

import re
from typing import Any

from storefront.config import Product
from storefront.models import CreateMachineRequest


SSH_PUBLIC_KEY_RE = re.compile(
    r"^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) [A-Za-z0-9+/=]+(?: .*)?$"
)


class ValidationError(Exception):
    pass


def parse_create_machine_request(payload: Any, product: Product) -> CreateMachineRequest:
    if not isinstance(payload, dict):
        raise ValidationError("Request body must be a JSON object.")

    duration = payload.get("duration_minutes")
    ssh_public_key = payload.get("ssh_public_key")

    if not isinstance(duration, int):
        raise ValidationError("duration_minutes must be an integer.")
    if duration < product.min_duration_minutes or duration > product.max_duration_minutes:
        raise ValidationError(
            f"duration_minutes must be between {product.min_duration_minutes} and {product.max_duration_minutes}."
        )
    if not isinstance(ssh_public_key, str) or not SSH_PUBLIC_KEY_RE.match(ssh_public_key.strip()):
        raise ValidationError("ssh_public_key must be a valid SSH public key.")

    return CreateMachineRequest(
        duration_minutes=duration,
        ssh_public_key=ssh_public_key.strip(),
    )

