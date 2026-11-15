CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  label TEXT,
  public_jwk TEXT,
  status TEXT CHECK(status IN ('pending','active','locked','revoked')),
  fails_window INT DEFAULT 0,
  fails_since_success INT DEFAULT 0,
  lock_level INT DEFAULT 0,
  locked_until INT DEFAULT 0,
  created_at INT,
  last_seen INT
);
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  label TEXT,
  expires_at INT,
  used INT DEFAULT 0,
  pin_fails INT DEFAULT 0
);
CREATE TABLE challenges (nonce TEXT PRIMARY KEY, device_id TEXT, expires_at INT);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, device_id TEXT, created_at INT, last_used INT);
CREATE TABLE pin_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, at INT);
CREATE TABLE versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INT,
  updated_at INT,
  device_label TEXT,
  kind TEXT,
  based_on INT,
  size INT,
  iv TEXT,
  blob TEXT
);
CREATE TABLE translate_usage (day TEXT PRIMARY KEY, count INT);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INT, event TEXT, device_id TEXT, ok INT);
