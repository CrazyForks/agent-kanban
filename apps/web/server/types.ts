import type { Session, User } from "better-auth";

export interface Env {
  DB: D1Database;
  AE: AnalyticsEngineDataset;
  EMAIL: SendEmail;
  TUNNEL_RELAY: DurableObjectNamespace;
  ASSETS: Fetcher;
  AUTH_SECRET: string;
  ALLOWED_HOSTS: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  MAILS_ADMIN_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  AK_API_URL?: string;
  AMA_ORIGIN?: string;
  AMA_OAUTH_TOKEN_URL?: string;
  AMA_OAUTH_CLIENT_ID?: string;
  AMA_OAUTH_CLIENT_SECRET?: string;
  AMA_OAUTH_SCOPE?: string;
  // ES256 private key (JWK JSON, with kid) used to sign runner subject tokens.
  // The matching public JWK is served at /.well-known/jwks.json and registered
  // as a federated credential under AK's application in FlareAuth.
  AK_FEDERATED_SIGNING_KEY?: string;
  // Stable issuer identity for runner federation; defaults to AK_API_URL.
  // Needed when AK_API_URL is an ephemeral tunnel (dev) but the flareauth
  // federated-credential registration is a fixed identity.
  AK_FEDERATED_ISSUER?: string;
  AMA_RUNNER_VERSION?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  // base64 of the App's PKCS#8 PEM private key
  GITHUB_APP_PRIVATE_KEY?: string;
  // interim server-level fallback push token for cloud sessions
  GITHUB_AGENT_TOKEN?: string;
  MIN_CLI_VERSION?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    ownerId: string;
    identityType: "user" | "machine" | "agent:worker" | "agent:leader";
    apiKeyId?: string;
    machineId?: string;
    agentId?: string;
    sessionId?: string;
    agentCapabilities?: string[];
    user?: User;
    session?: Session;
  }
}
