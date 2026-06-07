CREATE TABLE runtime_agent_sessions (
  id                    TEXT PRIMARY KEY,
  owner_id              TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  runtime_source        TEXT NOT NULL CHECK(runtime_source IN ('ama')),
  runtime_session_id    TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed')),
  public_key            TEXT NOT NULL,
  delegation_proof      TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd        INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at             TEXT
);

CREATE INDEX idx_runtime_agent_sessions_owner ON runtime_agent_sessions(owner_id);
CREATE INDEX idx_runtime_agent_sessions_agent ON runtime_agent_sessions(agent_id);
CREATE INDEX idx_runtime_agent_sessions_runtime ON runtime_agent_sessions(runtime_source, runtime_session_id);
