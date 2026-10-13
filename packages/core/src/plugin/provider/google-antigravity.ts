import { Effect, Stream } from "effect"
import { Money } from "@opencode/schema/money"
import { define } from "@opencode/plugin/effect/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { Credential } from "../../credential.js"
import { Bus } from "../../bus.js"
import { Integration } from "../../integration.js"
import { Provider } from "../../provider.js"
import { beginAntigravityLogin, refreshAntigravityToken } from "./google-antigravity/oauth.js"
import {
  INTERNAL_SESSION_HEADER,
  isAntigravityModel,
  rewriteAntigravityRequest,
  unwrapAntigravityResponse,
} from "./google-antigravity/transport.js"

const providerID = Provider.ID.google
const integrationID = Integration.ID.make("google")
const methodID = Integration.MethodID.make("google-antigravity-browser")

function projectID(value: Credential.OAuth): string | undefined {
  const id = value.metadata?.projectId
  return typeof id === "string" && id.length > 0 ? id : undefined
}

const signIn = {
  integrationID,
  method: {
    id: methodID,
    type: "oauth",
    label: "Google AI Pro / Antigravity (browser)",
  },
  authorize: () =>
    Effect.gen(function* () {
      const login = yield* Effect.tryPromise(() => beginAntigravityLogin())
      return {
        mode: "auto" as const,
        url: login.url,
        instructions: login.instructions,
        callback: Effect.tryPromise(async () => {
          const result = await login.callback()
          if (result.type !== "success") throw new Error("Google Antigravity authorization failed")
          return Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: result.access,
            refresh: result.refresh,
            expires: Math.max(0, result.expires),
            metadata: {
              ...(result.projectId ? { projectId: result.projectId } : {}),
              ...(result.accountId ? { accountId: result.accountId } : {}),
              ...(result.email ? { email: result.email } : {}),
            },
          })
        }),
      }
    }),
  refresh: (credential) =>
    Effect.tryPromise(async () => {
      const next = await refreshAntigravityToken(credential.refresh, projectID(credential))
      if (!next.projectId) throw new Error("Antigravity refresh did not resolve a Cloud Code Assist project")
      return Credential.OAuth.make({
        ...credential,
        type: "oauth",
        methodID,
        access: next.access,
        refresh: next.refresh,
        expires: Math.max(0, next.expires),
        metadata: { ...credential.metadata, projectId: next.projectId },
      })
    }),
  label: (credential) => {
    const email = credential.metadata?.email
    return typeof email === "string" ? email : undefined
  },
} satisfies IntegrationOAuthMethodRegistration

export const GoogleAntigravityPlugin = define({
  id: "openfork.provider.google.antigravity",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    let oauthActive = false
    let source: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>

    const load = Effect.fn("GoogleAntigravityPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      const value = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      oauthActive = value?.type === "oauth" && value.methodID === methodID
      source = oauthActive ? connection : undefined
    })

    yield* ctx.integration.transform((editor) => {
      editor.method.update(signIn)
    })
    yield* load()

    // OAuth is a free, Gemini-only Cloud Code Assist connection. Do not alter API-key traffic.
    yield* ctx.provider.transform((providers) => {
      if (!oauthActive || !source) return
      const item = providers.get(providerID)
      if (!item) return
      providers.add({ info: item.provider, models: Array.from(item.models.values()), sourceConnection: source })
    })
    yield* ctx.model.transform((models) => {
      if (!oauthActive) return
      for (const item of models.list(providerID)) {
        models.update(item.providerID, item.id, (model) => {
          if (!isAntigravityModel(model.modelID ?? model.id) || model.package?.includes("/interactions")) {
            model.enabled = false
            return
          }
          const zero = Money.USDPerMillionTokens.zero
          model.cost = model.cost.map((tier) => ({
            ...tier,
            input: zero,
            output: zero,
            cache: { read: zero, write: zero },
          }))
        })
      }
    })

    // Unlike V1's AI SDK fetch override, V2's native Gemini transport uses HTTP hooks.
    // Intercept both the generated request and the returned Cloud Code Assist envelope.
    yield* ctx.session.hook(
      "model.request",
      (event) =>
        Effect.sync(() => {
          if (oauthActive && isAntigravityModel(event.model.id)) {
            event.headers[INTERNAL_SESSION_HEADER] = event.sessionID
          }
        }),
      { providerID },
    )
    yield* ctx.session.hook(
      "http.request",
      (event) =>
        Effect.gen(function* () {
          if (!isAntigravityModel(event.model.id)) return
          const connection = yield* ctx.integration.connection.active(integrationID)
          if (!connection) return
          const value = yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
          if (value?.type !== "oauth" || value.methodID !== methodID) return
          const project = projectID(value)
          if (!project) return yield* Effect.die(new Error("Antigravity credential is missing a project ID"))
          event.request = yield* Effect.tryPromise(() =>
            rewriteAntigravityRequest(event.request, value.access, project),
          ).pipe(Effect.orDie)
        }),
      { providerID },
    )
    yield* ctx.session.hook(
      "http.response",
      (event) =>
        Effect.gen(function* () {
          if (!event.request.url.includes("/v1internal:") || !isAntigravityModel(event.model.id)) return
          event.response = yield* Effect.tryPromise(() => unwrapAntigravityResponse(event.response)).pipe(Effect.orDie)
        }),
      { providerID },
    )

    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(() =>
        load().pipe(Effect.andThen(ctx.provider.reload()), Effect.andThen(ctx.model.reload())),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
