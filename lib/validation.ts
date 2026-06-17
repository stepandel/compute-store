import type { Product } from "@/lib/config";
import type { CreateMachineRequest } from "@/lib/models";

const SSH_PUBLIC_KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) [A-Za-z0-9+/=]+(?: .*)?$/;

export class ValidationError extends Error {}

export function parseCreateMachineRequest(payload: unknown, product: Product): CreateMachineRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const body = payload as Record<string, unknown>;
  const duration = body.duration_minutes;
  const sshPublicKey = body.ssh_public_key;

  if (typeof duration !== "number" || !Number.isInteger(duration)) {
    throw new ValidationError("duration_minutes must be an integer.");
  }
  if (duration < product.minDurationMinutes || duration > product.maxDurationMinutes) {
    throw new ValidationError(
      `duration_minutes must be between ${product.minDurationMinutes} and ${product.maxDurationMinutes}.`,
    );
  }
  if (typeof sshPublicKey !== "string" || !SSH_PUBLIC_KEY_RE.test(sshPublicKey.trim())) {
    throw new ValidationError("ssh_public_key must be a valid SSH public key.");
  }

  return {
    durationMinutes: duration,
    sshPublicKey: sshPublicKey.trim(),
  };
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
