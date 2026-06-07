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
  AMA_ACCESS_TOKEN?: string;
  AMA_OAUTH_TOKEN_URL?: string;
  AMA_OAUTH_CLIENT_ID?: string;
  AMA_OAUTH_CLIENT_SECRET?: string;
  AMA_OAUTH_SCOPE?: string;
  AMA_PROJECT_ID?: string;
  AMA_AUDIENCE?: string;
  AMA_TOKEN_EXCHANGE_URL?: string;
  AMA_TOKEN_EXCHANGE_CLIENT_ID?: string;
  AMA_TOKEN_EXCHANGE_CLIENT_SECRET?: string;
  AK_FEDERATED_RUNNER_ISSUER?: string;
  AK_FEDERATED_RUNNER_SUBJECT_SECRET?: string;
  AMA_DEFAULT_ENVIRONMENT_ID?: string;
  AMA_SESSION_SECRET_VAULT_ID?: string;
  AK_ENABLE_LEGACY_DAEMON_API?: string;
  AK_ENABLE_LEGACY_TUNNEL?: string;
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
