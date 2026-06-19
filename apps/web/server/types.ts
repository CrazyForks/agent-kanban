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
  // OIDC discovery document for AMA. When unset it is derived from
  // AMA_OAUTH_TOKEN_URL (the /oauth2/token suffix is replaced with the
  // well-known discovery path).
  AMA_OIDC_DISCOVERY_URL?: string;
  AMA_RUNNER_VERSION?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  // base64 of the App's PKCS#8 PEM private key
  GITHUB_APP_PRIVATE_KEY?: string;
  // public App slug, used to build the install URL github.com/apps/<slug>/installations/new
  GITHUB_APP_SLUG?: string;
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
