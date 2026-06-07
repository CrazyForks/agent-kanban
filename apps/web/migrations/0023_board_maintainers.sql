CREATE TABLE board_maintainers (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  board_id            TEXT NOT NULL,
  repository_id       TEXT,
  ak_agent_id         TEXT NOT NULL,
  ama_agent_id        TEXT NOT NULL,
  ama_environment_id  TEXT NOT NULL,
  ama_schedule_id     TEXT NOT NULL,
  name                TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  interval_seconds    INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  last_run_at         TEXT,
  last_ama_session_id TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_board_maintainers_owner_board ON board_maintainers(owner_id, board_id);
CREATE UNIQUE INDEX idx_board_maintainers_ama_schedule ON board_maintainers(ama_schedule_id);

CREATE TABLE board_maintainer_runs (
  id                  TEXT PRIMARY KEY,
  maintainer_id       TEXT NOT NULL,
  board_id            TEXT NOT NULL,
  ama_schedule_run_id TEXT NOT NULL,
  ama_session_id      TEXT,
  scheduled_for       TEXT NOT NULL,
  heartbeat_at        TEXT NOT NULL,
  status              TEXT NOT NULL,
  correlation_id      TEXT NOT NULL,
  error_message       TEXT,
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_board_maintainer_runs_ama_run ON board_maintainer_runs(ama_schedule_run_id);
CREATE INDEX idx_board_maintainer_runs_maintainer_created ON board_maintainer_runs(maintainer_id, created_at DESC);
