// @vitest-environment node

import { describe, expect, it } from "vitest";
import { amaOidcResource } from "./betterAuth";

describe("amaOidcResource", () => {
  it("uses AMA_ORIGIN as the OIDC resource indicator without trailing slashes", () => {
    expect(amaOidcResource({ AMA_ORIGIN: "https://ama.tftt.cc///" })).toBe("https://ama.tftt.cc");
  });

  it("omits the resource indicator when AMA_ORIGIN is not configured", () => {
    expect(amaOidcResource({ AMA_ORIGIN: "  " })).toBeNull();
    expect(amaOidcResource({})).toBeNull();
  });
});
