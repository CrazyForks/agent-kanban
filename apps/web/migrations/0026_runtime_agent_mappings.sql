CREATE TABLE IF NOT EXISTS runtime_agent_mappings (
  owner_id TEXT NOT NULL,
  ak_agent_id TEXT NOT NULL,
  runtime_source TEXT NOT NULL,
  runtime_agent_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_id, ak_agent_id, runtime_source),
  FOREIGN KEY (ak_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_agent_mappings_runtime_agent
  ON runtime_agent_mappings(runtime_source, runtime_agent_id);
