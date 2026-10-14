import { expect, it } from "vitest";
import { handlePostProjectFeedback } from "../../src/runtime/http/feedback.js";
import { createFeedbackTestFake } from "../../src/runtime/fakes/feedback.js";

const projectId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e8f";
it("T05-06 bounds streamed bodies without trusting Content-Length or calling persistence", async () => {
  const fake = createFeedbackTestFake({ type: "success" });
  const response = await handlePostProjectFeedback(new Request("https://example.com/feedback", {
    method: "POST", headers: { "Idempotency-Key": "body-limit", "Content-Length": "1" }, body: " ".repeat(17000),
  }), { projectId }, { service: fake, rateLimit: { check: async () => ({ allowed: true }) } });
  expect(response.status).toBe(400); expect(fake.calls).toHaveLength(0);
  expect((await response.json()).detail).toBe("Request body exceeds the allowed limit.");
});
it("T05-06 configured abuse rejection is 429 with Retry-After before body consumption", async () => {
  const fake = createFeedbackTestFake({ type: "success" });
  const response = await handlePostProjectFeedback(new Request("https://example.com/feedback", {
    method: "POST", headers: { "Idempotency-Key": "abuse-limit" }, body: "malformed-private-text",
  }), { projectId }, { service: fake, rateLimit: { check: async () => ({ allowed: false, retryAfterSeconds: 17 }) } });
  expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("17"); expect(fake.calls).toHaveLength(0);
  expect(await response.text()).not.toContain("malformed-private-text");
});
