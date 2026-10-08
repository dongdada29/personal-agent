/** Ordered, transactional migrations. Keep to Node 22.18 DatabaseSync basics. */
export const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_human','paused','interrupted','completed','failed','cancelled')),
      delivery_status TEXT NOT NULL CHECK(delivery_status IN ('pending','accepted','returned')),
      pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1)),
      active_attempt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      engine TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE task_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT REFERENCES attempts(id),
      type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX task_events_cursor ON task_events(task_id, seq);
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX artifacts_task ON artifacts(task_id);
    CREATE TABLE commands (
      command_id TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
}, {
  version: 2,
  sql: `
    ALTER TABLE tasks ADD COLUMN execution_json TEXT NOT NULL DEFAULT '{"engine":"fake"}';
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE stages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL REFERENCES attempts(id), payload_json TEXT NOT NULL);
    CREATE INDEX stages_task ON stages(task_id);
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL REFERENCES attempts(id), stage_id TEXT NOT NULL REFERENCES stages(id), payload_json TEXT NOT NULL);
    CREATE INDEX agent_runs_task ON agent_runs(task_id);
    CREATE TABLE verifications (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL REFERENCES attempts(id), stage_id TEXT NOT NULL REFERENCES stages(id), payload_json TEXT NOT NULL);
    CREATE INDEX verifications_task ON verifications(task_id);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL REFERENCES attempts(id), run_id TEXT NOT NULL REFERENCES agent_runs(id), status TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE INDEX approvals_pending ON approvals(status,task_id);
  `,
}, {
  version: 3,
  sql: `
    CREATE TABLE instance_settings (id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL);
    CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, role TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE owned_processes (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), attempt_id TEXT REFERENCES attempts(id), status TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE INDEX owned_processes_active ON owned_processes(status);
    CREATE TABLE command_intents (command_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), request_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE audit_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
  `,
}, {
  version: 4,
  sql: `
    CREATE TABLE security_policy (id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL);
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      session_hash TEXT NOT NULL UNIQUE,
      csrf_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE pairing_tickets (
      id TEXT PRIMARY KEY,
      ticket_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      issuer_device_id TEXT REFERENCES devices(id),
      command_id TEXT UNIQUE
    );
    CREATE INDEX pairing_tickets_issuer ON pairing_tickets(issuer_device_id,consumed_at);
    CREATE TABLE auth_commands (
      command_id TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `,
}];
