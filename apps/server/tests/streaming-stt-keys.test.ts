import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db.js";
import { getApiKeyForProvider } from "../src/lib/streaming-stt.js";

describe("getApiKeyForProvider", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM api_keys");
  });

  it("resolves stored BYOK keys for cleanup LLM providers", () => {
    getDb()
      .prepare("INSERT INTO api_keys (provider, key) VALUES (?, ?)")
      .run("zai", "zai-test-key");

    expect(getApiKeyForProvider("zai")).toBe("zai-test-key");
  });

  it("uses the local sentinel for Starling", () => {
    expect(getApiKeyForProvider("local-starling")).toBe("local");
  });
});
