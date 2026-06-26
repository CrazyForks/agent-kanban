import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WORKER_AUTH_SESSION_FILE } from "../paths.js";

export interface WorkerAuthSession {
  agentId: string;
  sessionId: string;
  apiUrl: string;
  privateKeyJwk: JsonWebKey;
  boardId?: string;
  maintainerId?: string;
  createdAt: number;
}

export function readWorkerAuthSession(): WorkerAuthSession | null {
  try {
    return JSON.parse(readFileSync(WORKER_AUTH_SESSION_FILE, "utf-8")) as WorkerAuthSession;
  } catch {
    return null;
  }
}

export function writeWorkerAuthSession(session: WorkerAuthSession): void {
  mkdirSync(dirname(WORKER_AUTH_SESSION_FILE), { recursive: true });
  writeFileSync(WORKER_AUTH_SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

export function clearWorkerAuthSession(): void {
  rmSync(WORKER_AUTH_SESSION_FILE, { force: true });
}
