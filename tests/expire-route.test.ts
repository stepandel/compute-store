import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GET } from "@/app/api/machines/expire/route";

describe("expire route", () => {
  it("requires CRON_SECRET when configured", async () => {
    const originalSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-cron-secret";

    try {
      const unauthorized = await GET(new Request("http://localhost/api/machines/expire"));
      assert.equal(unauthorized.status, 401);

      const authorized = await GET(
        new Request("http://localhost/api/machines/expire", {
          headers: {
            authorization: "Bearer test-cron-secret",
          },
        }),
      );
      assert.equal(authorized.status, 200);
    } finally {
      if (originalSecret === undefined) {
        delete process.env.CRON_SECRET;
      } else {
        process.env.CRON_SECRET = originalSecret;
      }
    }
  });
});

