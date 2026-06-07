CREATE TABLE IF NOT EXISTS ama_owner_runtime_bindings (
  owner_id TEXT PRIMARY KEY,
  ama_project_id TEXT NOT NULL,
  external_tenant_id TEXT NOT NULL,
  session_secret_vault_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO ama_owner_runtime_bindings (
  owner_id,
  ama_project_id,
  external_tenant_id,
  metadata,
  created_at,
  updated_at
)
SELECT
  owner_id,
  ama_project_id,
  external_tenant_id,
  metadata,
  created_at,
  updated_at
FROM ama_owner_mappings
