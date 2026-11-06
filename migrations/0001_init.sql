CREATE TABLE entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('memory', 'worklog')),
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  project    TEXT,
  tags       TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  device     TEXT,
  created_at TEXT NOT NULL,              -- ISO 8601 UTC
  updated_at TEXT NOT NULL
);

CREATE INDEX entries_updated_at ON entries (updated_at DESC);
CREATE INDEX entries_project ON entries (project, updated_at DESC);

-- The trigram tokenizer matches substrings, which suits Korean: particles stick
-- to words, so a word-based tokenizer wouldn't find "메모리" in "메모리를".
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title,
  content,
  tags,
  content = 'entries',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts (entries_fts, rowid, title, content, tags)
  VALUES ('delete', old.id, old.title, old.content, old.tags);
END;

CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts (entries_fts, rowid, title, content, tags)
  VALUES ('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO entries_fts (rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;
