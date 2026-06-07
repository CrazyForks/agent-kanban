CREATE TABLE IF NOT EXISTS ama_owner_mappings (
  owner_id TEXT PRIMARY KEY,
  ama_project_id TEXT NOT NULL,
  external_tenant_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
