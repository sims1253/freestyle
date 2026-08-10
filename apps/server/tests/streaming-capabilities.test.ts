import { describe, expect, it } from "vitest";
import {
  supportsSessionTransport,
  supportsStreaming,
} from "../src/lib/streaming/registry.js";

describe("streaming capabilities", () => {
  it("exposes Starling as the only streaming voice transport", () => {
    expect(supportsStreaming("local-starling", "local-starling/parakeet")).toBe(
      true,
    );
    expect(
      supportsSessionTransport("local-starling", "local-starling/parakeet"),
    ).toBe(true);
    expect(supportsStreaming("deepgram", "deepgram/nova-3")).toBe(false);
  });
});
