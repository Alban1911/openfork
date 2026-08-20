import { describe, expect, test } from "bun:test"
import { extractProjectId, generatePKCE } from "../../src/plugin/google-antigravity/oauth"
import {
  mapAntigravityModel,
  stableSessionId,
  unwrapAntigravityJson,
  unwrapAntigravitySseLine,
} from "../../src/plugin/google-antigravity/transport"

describe("Google Antigravity OAuth", () => {
  test("generates an S256 PKCE pair", () => {
    const first = generatePKCE()
    const second = generatePKCE()
    expect(first.verifier.length).toBeGreaterThan(30)
    expect(first.challenge.length).toBeGreaterThan(30)
    expect(first).not.toEqual(second)
  })

  test("extracts Cloud Code Assist project ids", () => {
    expect(extractProjectId({ cloudaicompanionProject: "project-a" })).toBe("project-a")
    expect(extractProjectId({ project: { id: "project-b" } })).toBe("project-b")
    expect(extractProjectId({})).toBeUndefined()
  })
})

describe("Google Antigravity transport", () => {
  test("maps picker ids to wire ids", () => {
    expect(mapAntigravityModel("gemini-3.7-flash")).toBe("gemini-3.7-flash-tiered")
    expect(mapAntigravityModel("gemini-3.1-pro")).toBe("gemini-pro-agent")
    expect(mapAntigravityModel("gemini-3.1-pro-low")).toBe("gemini-3.1-pro-low")
  })

  test("creates deterministic numeric session ids", () => {
    const first = stableSessionId("session-123")
    expect(first).toBe(stableSessionId("session-123"))
    expect(first).toMatch(/^-\d+$/)
    expect(first).not.toBe(stableSessionId("session-456"))
  })

  test("unwraps JSON and SSE response envelopes", () => {
    const response = { candidates: [{ finishReason: "STOP" }] }
    expect(unwrapAntigravityJson({ response })).toEqual(response)
    expect(unwrapAntigravitySseLine(`data: ${JSON.stringify({ response })}`)).toBe(
      `data: ${JSON.stringify(response)}`,
    )
  })
})
