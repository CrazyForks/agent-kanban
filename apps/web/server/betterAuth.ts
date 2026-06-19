import { agentAuth } from "@better-auth/agent-auth";
import { apiKey } from "@better-auth/api-key";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, bearer, genericOAuth } from "better-auth/plugins";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { D1 } from "./db";
import { sendVerificationEmail } from "./emailService";
import type { Env } from "./types";

// AMA can only be unlinked once the user has no AMA-backed resources left: any
// non-builtin agent or any machine. Builtin agents (auto-seeded, no AMA agent)
// don't count; the project/vault are auto-provisioned containers, not user
// resources. The user clears their agents/machines first, then disconnects.
export async function hasAmaResources(db: D1, ownerId: string): Promise<boolean> {
  const agent = await db.prepare("SELECT 1 FROM agents WHERE owner_id = ? AND builtin = 0 LIMIT 1").bind(ownerId).first();
  if (agent) return true;
  const machine = await db.prepare("SELECT 1 FROM machines WHERE owner_id = ? LIMIT 1").bind(ownerId).first();
  return Boolean(machine);
}

// AMA OIDC discovery url. Explicit AMA_OIDC_DISCOVERY_URL wins; otherwise it is
// derived from the client-credentials token url. Returns undefined in
// standalone mode (no AMA configured) so the provider plugin is skipped.
function amaOidcDiscoveryUrl(env: Env): string | undefined {
  if (env.AMA_OIDC_DISCOVERY_URL) return env.AMA_OIDC_DISCOVERY_URL;
  if (!env.AMA_OAUTH_TOKEN_URL) return undefined;
  return `${env.AMA_OAUTH_TOKEN_URL.replace(/\/oauth2\/token$/, "")}/.well-known/openid-configuration`;
}

// Registers AMA as a generic OIDC provider so each AK user can link their own
// AMA account. Only added when AMA OAuth is configured; standalone AK skips it.
function amaProviderPlugins(env: Env): BetterAuthPlugin[] {
  const discoveryUrl = amaOidcDiscoveryUrl(env);
  if (!discoveryUrl || !env.AMA_OAUTH_CLIENT_ID || !env.AMA_OAUTH_CLIENT_SECRET) return [];
  return [
    genericOAuth({
      config: [
        {
          providerId: "ama",
          discoveryUrl,
          clientId: env.AMA_OAUTH_CLIENT_ID,
          clientSecret: env.AMA_OAUTH_CLIENT_SECRET,
          scopes: ["openid", "profile", "email", "offline_access"],
          pkce: true,
        },
      ],
    }),
  ];
}

export function createAuth(env: Env) {
  return betterAuth({
    database: {
      db: new Kysely({ dialect: new D1Dialect({ database: env.DB }) }),
      type: "sqlite",
    },
    basePath: "/api/auth",
    baseURL: {
      allowedHosts: authAllowedHosts(env),
      fallback: `https://${env.ALLOWED_HOSTS.split(",")[0]}`,
      protocol: "auto",
    },
    secret: env.AUTH_SECRET,
    // The AK user links their AMA account (a separate FlareAuth identity) whose
    // email need not match their AK login email, so account linking must allow
    // different emails — otherwise BetterAuth rejects the link with
    // "email_doesn't_match". Linking is user-initiated and authenticated, and the
    // linked token is only used for that user's own AMA calls.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["ama"],
        allowDifferentEmails: true,
      },
    },
    // Block disconnecting AMA while AMA-backed resources still exist, so we never
    // leave dangling references. The user deletes their agents/machines first.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/unlink-account") return;
        if ((ctx.body as { providerId?: string } | undefined)?.providerId !== "ama") return;
        const session = await getSessionFromCtx(ctx);
        const ownerId = session?.user?.id;
        if (ownerId && (await hasAmaResources(env.DB, ownerId))) {
          throw new APIError("BAD_REQUEST", { message: "Remove your agents and machines before disconnecting AMA" });
        }
      }),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
        ...coreFields,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        ...additionalFields,
        id,
      }),
    },
    emailVerification: {
      autoSignInAfterVerification: true,
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }, request) => {
        await sendVerificationEmail(env, user.email, verificationPageUrl(env, url, request));
      },
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        scope: ["user", "admin:gpg_key"],
      },
    },
    plugins: [
      bearer(),
      // Admin plugin enables /api/auth/admin/* endpoints (list-users, ban-user, set-role, etc.)
      // First admin must be set manually via D1 console:
      //   UPDATE user SET role = 'admin' WHERE email = '...'
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
      }),
      apiKey({
        defaultPrefix: "ak_",
        enableMetadata: true,
        rateLimit: { enabled: false },
      }),
      agentAuth({
        allowedKeyAlgorithms: ["Ed25519"],
        agentSessionTTL: 86400,
        agentMaxLifetime: 86400,
        allowDynamicHostRegistration: true,
        modes: ["autonomous"],
        rateLimit: {
          "/agent/session": { window: 60, max: 6000 },
        },
        capabilities: [
          { name: "task:claim", description: "Claim an assigned task" },
          { name: "task:review", description: "Submit a task for review" },
          { name: "task:complete", description: "Complete a task in review" },
          { name: "task:reject", description: "Reject a task back to in-progress" },
          { name: "task:cancel", description: "Cancel a task" },
          { name: "task:log", description: "Add logs to a task" },
          { name: "task:message", description: "Send and read task messages" },
          { name: "agent:usage", description: "Report token usage" },
        ],
      }),
      ...amaProviderPlugins(env),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

function authAllowedHosts(env: Env): string[] {
  const hosts = env.ALLOWED_HOSTS.split(",");
  const localHosts = ["localhost:*", "127.0.0.1:*"];
  return [...hosts, ...localHosts.filter((host) => !hosts.includes(host))];
}

function verificationUrlForRequest(env: Env, url: string, request?: Request): string {
  if (!request) return new URL(url, `https://${env.ALLOWED_HOSTS.split(",")[0]}`).toString();
  const origin = new URL(request.url).origin;
  return new URL(url, origin).toString();
}

function verificationPageUrl(env: Env, url: string, request?: Request): string {
  const resolved = new URL(verificationUrlForRequest(env, url, request));
  const page = new URL("/auth/verify", resolved.origin);
  page.searchParams.set("token", resolved.searchParams.get("token") || "");
  return page.toString();
}
