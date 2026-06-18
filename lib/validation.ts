import type { Product } from "@/lib/config";
import type { CreateMachineRequest } from "@/lib/models";

const SSH_PUBLIC_KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) [A-Za-z0-9+/=]+(?: .*)?$/;

// A 4096-bit RSA key in OpenSSH format is ~750 chars; 8 KB leaves generous
// headroom while preventing oversized keys from bloating the lease store.
const MAX_SSH_PUBLIC_KEY_LENGTH = 8 * 1024;

// request_id is an opaque correlation token; keep it to a conservative
// id-shaped charset and length so it can be safely echoed into payment
// challenge metadata without bloating the WWW-Authenticate header.
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]+$/;
const MAX_REQUEST_ID_LENGTH = 200;

export class ValidationError extends Error {}

export function parseCreateMachineRequest(payload: unknown, product: Product): CreateMachineRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const body = payload as Record<string, unknown>;
  const duration = body.duration_minutes;
  const sshPublicKey = body.ssh_public_key;
  const requestId = parseOptionalRequestId(body.request_id);

  if (typeof duration !== "number" || !Number.isInteger(duration)) {
    throw new ValidationError("duration_minutes must be an integer.");
  }
  if (duration < product.minDurationMinutes || duration > product.maxDurationMinutes) {
    throw new ValidationError(
      `duration_minutes must be between ${product.minDurationMinutes} and ${product.maxDurationMinutes}.`,
    );
  }
  if (typeof sshPublicKey !== "string") {
    throw new ValidationError("ssh_public_key must be a valid SSH public key.");
  }
  const trimmedKey = sshPublicKey.trim();
  if (trimmedKey.length > MAX_SSH_PUBLIC_KEY_LENGTH) {
    throw new ValidationError(`ssh_public_key must be at most ${MAX_SSH_PUBLIC_KEY_LENGTH} characters.`);
  }
  if (!SSH_PUBLIC_KEY_RE.test(trimmedKey)) {
    throw new ValidationError("ssh_public_key must be a valid SSH public key.");
  }

  return {
    durationMinutes: duration,
    sshPublicKey: sshPublicKey.trim(),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

function parseOptionalRequestId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError("request_id must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > MAX_REQUEST_ID_LENGTH) {
    throw new ValidationError(`request_id must be at most ${MAX_REQUEST_ID_LENGTH} characters.`);
  }
  if (!REQUEST_ID_RE.test(trimmed)) {
    throw new ValidationError("request_id may only contain letters, digits, and the characters _.:-");
  }
  return trimmed;
}

export function parseExtendMachineRequest(payload: unknown): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const body = payload as Record<string, unknown>;
  const additionalMinutes = body.additional_minutes;

  if (typeof additionalMinutes !== "number" || !Number.isInteger(additionalMinutes)) {
    throw new ValidationError("additional_minutes must be an integer.");
  }
  if (additionalMinutes < 1) {
    throw new ValidationError("additional_minutes must be greater than zero.");
  }

  return additionalMinutes;
}
