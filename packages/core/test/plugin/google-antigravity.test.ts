import { describe, expect, test } from "bun:test"
import { extractProjectId, generatePKCE } from "../../src/plugin/provider/google-antigravity/oauth"
import {
  mapAntigravityModel,
  INTERNAL_SESSION_HEADER,
  rewriteAntigravityRequest,
  unwrapAntigravityResponse,
  stableSessionId,
  unwrapAntigravityJson,
  unwrapAntigravitySseLine,
} from "../../src/plugin/provider/google-antigravity/transport"

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
    expect(mapAntigravityModel("gemini-3.8-flash")).toBe("gemini-3.8-flash-medium")
    expect(
      mapAntigravityModel("gemini-3.8-flash", {
        generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
      }),
    ).toBe("gemini-3.8-flash-high")
    expect(mapAntigravityModel("gemini-3.8-flash-low")).toBe("gemini-3.8-flash-low")
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

  test("rewrites a native Gemini request using OAuth and Cloud Code Assist envelope", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
    const incoming = new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [INTERNAL_SESSION_HEADER]: "session-123" },
        body: JSON.stringify(body),
      },
    )
    const outgoing = await rewriteAntigravityRequest(incoming, "test-access", "test-project")
    expect(new URL(outgoing.url).pathname).toBe("/v1internal:streamGenerateContent")
    expect(new URL(outgoing.url).searchParams.get("alt")).toBe("sse")
    expect(outgoing.headers.get("authorization")).toBe("Bearer test-access")
    expect(outgoing.headers.has(INTERNAL_SESSION_HEADER)).toBe(false)
    const wire = (await outgoing.json()) as any
    expect(wire.model).toBe("gemini-3.8-flash-medium")
    expect(wire.project).toBe("test-project")
    expect(wire.request.sessionId).toBe(stableSessionId("session-123"))
    expect(wire.request.contents).toEqual(body.contents)
  })

  test("unwraps streaming Cloud Code Assist responses", async () => {
    const response = await unwrapAntigravityResponse(
      new Response('data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n', {
        headers: { "content-type": "text/event-stream", "content-length": "100" },
      }),
    )
    expect(response.headers.get("content-length")).toBeNull()
    expect(await response.text()).toBe('data: {"candidates":[{"finishReason":"STOP"}]}\n\n')
  })

})
