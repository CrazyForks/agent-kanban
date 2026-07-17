import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { readWorkerAuthSession } from "../auth/session.js";
import { ApiClient } from "./base.js";

export class AgentClient extends ApiClient {
  private agentId: string;
  private sessionId: string;
  private privateKey: CryptoKey;

  constructor(baseUrl: string, agentId: string, sessionId: string, privateKey: CryptoKey) {
    super(baseUrl);
    this.agentId = agentId;
    this.sessionId = sessionId;
    this.privateKey = privateKey;
  }

  static async fromEnv(): Promise<AgentClient | null> {
    const agentId = process.env.AK_AGENT_ID;
    const sessionId = process.env.AK_SESSION_ID;
    const keyJson = process.env.AK_AGENT_KEY;
    const apiUrl = process.env.AK_API_URL;
    if (!agentId || !sessionId || !keyJson || !apiUrl) {
      if (process.env.AK_WORKER !== "1") return null;
      const cached = readWorkerAuthSession();
      if (!cached) return null;
      const privateKey = await crypto.subtle.importKey("jwk", cached.privateKeyJwk, { name: "Ed25519" } as any, false, ["sign"]);
      return new AgentClient(cached.apiUrl, cached.agentId, cached.sessionId, privateKey);
    }

    const privateKey = await crypto.subtle.importKey("jwk", JSON.parse(keyJson), { name: "Ed25519" } as any, false, ["sign"]);
    return new AgentClient(apiUrl, agentId, sessionId, privateKey);
  }

  protected async authorize(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ sub: this.sessionId, aid: this.agentId, jti: randomUUID(), aud: this.baseUrl })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setIssuedAt(now - 30)
      .setExpirationTime(now + 60)
      .sign(this.privateKey);
    return `Bearer ${jwt}`;
  }

  getAgentId(): string {
    return this.agentId;
  }
  getSessionId(): string {
    return this.sessionId;
  }
}
