import { describe, it, expect } from "vitest";
import { rawEngagementPayloadSchema } from "@/schemas/engagement.schema.js";

describe("rawEngagementPayloadSchema", () => {
  it("accepts a valid engagement payload", () => {
    const r = rawEngagementPayloadSchema.safeParse({
      ext_equipe_id: "1949474",
      ext_poule_id: "168256",
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when ext_poule_id is missing", () => {
    const r = rawEngagementPayloadSchema.safeParse({
      ext_equipe_id: "1949474",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty ext_equipe_id", () => {
    const r = rawEngagementPayloadSchema.safeParse({
      ext_equipe_id: "",
      ext_poule_id: "1",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
