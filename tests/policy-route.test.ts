import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GET } from "@/app/acceptable-use/route";

describe("acceptable use route", () => {
  it("serves agent-readable acceptable use markdown", async () => {
    const response = await GET();
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(body, /# Acceptable Use/);
    assert.match(body, /Spam, unsolicited bulk messaging/);
    assert.match(body, /Terminate the machine as soon as the task is complete/);
  });
});
