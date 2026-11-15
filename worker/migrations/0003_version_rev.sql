-- Revision of a version row: bumped on every in-place auto-save, so a client base is {id, rev}.
ALTER TABLE versions ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
