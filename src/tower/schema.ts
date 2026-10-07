export const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS agents (
		id TEXT PRIMARY KEY, n INTEGER NOT NULL, callsign TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, model TEXT,
		color TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS intents (
		id TEXT PRIMARY KEY, seq INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, priority INTEGER NOT NULL,
		status TEXT NOT NULL, labels TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
		flight_id TEXT, landed_commit TEXT, depends_on TEXT NOT NULL DEFAULT '[]')`,
	`CREATE TABLE IF NOT EXISTS flights (
		id TEXT PRIMARY KEY, seq INTEGER NOT NULL, code TEXT NOT NULL, agent_id TEXT NOT NULL, intent_id TEXT NOT NULL,
		status TEXT NOT NULL, repo TEXT NOT NULL, base_commit TEXT NOT NULL, plan TEXT, created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL, landed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, touched TEXT NOT NULL DEFAULT '[]')`,
	`CREATE TABLE IF NOT EXISTS clearances (
		id TEXT PRIMARY KEY, flight_id TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
		created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
	`CREATE INDEX IF NOT EXISTS clearances_flight ON clearances(flight_id)`,
	`CREATE TABLE IF NOT EXISTS landings (
		id TEXT PRIMARY KEY, seq INTEGER NOT NULL, flight_id TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
		fork_head TEXT, trunk_before TEXT, trunk_after TEXT, changes TEXT NOT NULL DEFAULT '[]',
		conflicts TEXT NOT NULL DEFAULT '[]', tests TEXT, error TEXT, unioned INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL, finished_at INTEGER)`,
	`CREATE INDEX IF NOT EXISTS landings_status ON landings(status, seq)`,
	`ALTER TABLE landings ADD COLUMN review TEXT`,
	`CREATE TABLE IF NOT EXISTS contrail (
		id INTEGER PRIMARY KEY AUTOINCREMENT, flight_id TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL,
		text TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '[]', at INTEGER NOT NULL)`,
	`CREATE INDEX IF NOT EXISTS contrail_flight ON contrail(flight_id, id)`,
	`CREATE TABLE IF NOT EXISTS inbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT, flight_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
		at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)`,
	`CREATE INDEX IF NOT EXISTS inbox_flight ON inbox(flight_id, delivered)`,
	`CREATE TABLE IF NOT EXISTS events (
		seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, flight_id TEXT, agent_id TEXT,
		text TEXT NOT NULL, data TEXT)`,
	`CREATE TABLE IF NOT EXISTS symbol_history (
		target TEXT NOT NULL, path TEXT NOT NULL, landing_id TEXT NOT NULL, flight_id TEXT NOT NULL,
		commit_hash TEXT NOT NULL, at INTEGER NOT NULL)`,
	`CREATE INDEX IF NOT EXISTS symbol_history_path ON symbol_history(path, at)`,
	// When the flight's workspace fork was deleted (it ended FORK_RETENTION_MS earlier).
	`ALTER TABLE flights ADD COLUMN retired_at INTEGER`,
	// The crossing (a change landing in several sectors at once) this landing is one leg of.
	`ALTER TABLE landings ADD COLUMN crossing TEXT`,
	// When an operator revoked the agent's key.
	`ALTER TABLE agents ADD COLUMN revoked_at INTEGER`,
];
