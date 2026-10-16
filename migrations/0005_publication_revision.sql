ALTER TABLE videos ADD COLUMN publication_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(publication_revision) = 'integer' AND publication_revision >= 0);
