// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AmaLinkedAccountAuthError, amaRefreshTokenForm, assertAmaAccessToken, isUsableAmaAccessToken } from "./amaRuntime";

describe("assertAmaAccessToken", () => {
  it("accepts JWT access tokens for AMA API calls", () => {
    expect(assertAmaAccessToken("header.payload.signature")).toBe("header.payload.signature");
  });

  it("rejects opaque linked-account tokens with a reconnect error", () => {
    expect(() => assertAmaAccessToken("opaque-token")).toThrow(AmaLinkedAccountAuthError);
    expect(() => assertAmaAccessToken("opaque-token")).toThrow(/Reconnect AMA/);
  });
});

describe("isUsableAmaAccessToken", () => {
  const now = Date.parse("2026-07-04T03:00:00.000Z");

  it("uses stored JWT access tokens that are not close to expiry", () => {
    expect(isUsableAmaAccessToken("header.payload.signature", "2026-07-04T03:05:00.000Z", now)).toBe(true);
  });

  it("refreshes opaque, missing, expired, and near-expiry tokens", () => {
    expect(isUsableAmaAccessToken("opaque-token", "2026-07-04T03:05:00.000Z", now)).toBe(false);
    expect(isUsableAmaAccessToken(null, "2026-07-04T03:05:00.000Z", now)).toBe(false);
    expect(isUsableAmaAccessToken("header.payload.signature", null, now)).toBe(false);
    expect(isUsableAmaAccessToken("header.payload.signature", "2026-07-04T02:59:59.000Z", now)).toBe(false);
    expect(isUsableAmaAccessToken("header.payload.signature", "2026-07-04T03:00:20.000Z", now)).toBe(false);
  });
});

describe("amaRefreshTokenForm", () => {
  it("requests a JWT access token for the AMA resource during refresh", () => {
    const form = amaRefreshTokenForm("refresh-token", "https://ama.tftt.cc");

    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-token");
    expect(form.get("resource")).toBe("https://ama.tftt.cc");
  });
});
