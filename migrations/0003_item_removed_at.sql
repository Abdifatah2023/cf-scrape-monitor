-- Remember that an item was reported as removed, so the 'removed' change is
-- written once (not on every later run), and a reappearance can be reported
-- as 'added' again.
ALTER TABLE items ADD COLUMN removed_at TEXT;
