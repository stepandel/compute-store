import { NextResponse } from "next/server";

// Lightweight fixed-window rate limiter. When a Redis REST endpoint is
// configured (the same one used for the durable lease store in production) the
// counter is shared across serverless instances; otherwise it falls back to a
// per-instance in-memory map so local/dev still gets basic protection.
//
// Failure mode is fail-open: if Redis is unreachable we allow the request
// rather than take checkout down over a rate-limit backend hiccup.

export type BucketName = "checkout" | "create" | "manage" | "read";

const KEY_PREFIX = process.env.REDIS_REST_KEY ?? "checkout-proto:leases";
const WINDOW_SECONDS = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_SECONDS, 60);
const WRITE_MAX = parsePositiveInt(process.env.RATE_LIMIT_WRITE_MAX, 30);
const READ_MAX = parsePositiveInt(process.env.RATE_LIMIT_READ_MAX, 120);

const BUCKET_LIMITS: Record<BucketName, number> = {
  checkout: WRITE_MAX,
  create: WRITE_MAX,
  manage: WRITE_MAX,
  read: READ_MAX,
};

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
};

const memory = new Map<string, { count: number; resetAt: number }>();

export async function enforceRateLimit(request: Request, bucket: BucketName): Promise<NextResponse | null> {
  if (process.env.RATE_LIMIT_DISABLED === "true") {
    return null;
  }

  const limit = BUCKET_LIMITS[bucket];
  const result = await hit(bucket, clientIdentifier(request), limit);
  if (result.allowed) {
    return null;
  }

  return NextResponse.json(
    { error: "Rate limit exceeded. Slow down and retry." },
    {
      status: 429,
      headers: {
        "RateLimit-Limit": String(result.limit),
        "RateLimit-Remaining": String(result.remaining),
        "RateLimit-Reset": String(result.resetSeconds),
        "Retry-After": String(result.resetSeconds),
      },
    },
  );
}

async function hit(bucket: BucketName, identifier: string, limit: number): Promise<RateLimitResult> {
  const key = `${KEY_PREFIX}:ratelimit:${bucket}:${identifier}`;
  const restUrl = process.env.REDIS_REST_URL;
  const restToken = process.env.REDIS_REST_TOKEN;

  if (restUrl && restToken) {
    try {
      const count = Number(await redisCommand(restUrl, restToken, ["INCR", key]));
      if (count === 1) {
        await redisCommand(restUrl, restToken, ["EXPIRE", key, String(WINDOW_SECONDS)]);
      }
      let resetSeconds = WINDOW_SECONDS;
      if (count > limit) {
        const ttl = Number(await redisCommand(restUrl, restToken, ["TTL", key]));
        resetSeconds = ttl > 0 ? ttl : WINDOW_SECONDS;
      }
      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetSeconds,
      };
    } catch {
      // Fail open: never let the rate-limit backend break the request path.
      return { allowed: true, limit, remaining: limit, resetSeconds: WINDOW_SECONDS };
    }
  }

  return memoryHit(key, limit);
}

function memoryHit(key: string, limit: number): RateLimitResult {
  const now = Date.now();
  pruneMemory(now);

  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return { allowed: true, limit, remaining: limit - 1, resetSeconds: WINDOW_SECONDS };
  }

  entry.count += 1;
  const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  return {
    allowed: entry.count <= limit,
    limit,
    remaining: Math.max(0, limit - entry.count),
    resetSeconds,
  };
}

function pruneMemory(now: number): void {
  if (memory.size < 5000) {
    return;
  }
  for (const [key, entry] of memory) {
    if (entry.resetAt <= now) {
      memory.delete(key);
    }
  }
}

function clientIdentifier(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

async function redisCommand(url: string, token: string, command: string[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new Error(`Rate-limit Redis command failed with ${response.status}.`);
  }
  const payload = (await response.json()) as { result?: unknown; error?: string };
  if (payload.error) {
    throw new Error(`Rate-limit Redis command failed: ${payload.error}`);
  }
  return payload.result;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
