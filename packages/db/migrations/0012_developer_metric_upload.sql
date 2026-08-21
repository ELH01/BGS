-- A developer's metric workbook belongs to the developer it describes.
--
-- Bank metric imports hang off a site; developer imports had nowhere of their
-- own to hang, which made "find this developer's workbook so the allocation can
-- be written into a copy of it" a question the schema could not answer.
--
-- The file is kept, not merely parsed. The off-site write-back (spec 4.7) works
-- by patching the developer's own workbook — preserving its macros, validation
-- and every figure already in it — so the original has to still be there when
-- the quote is finished, which may be weeks later.

ALTER TABLE metric_import
    ADD COLUMN developer_id uuid REFERENCES developer (id) ON DELETE CASCADE;

ALTER TABLE metric_import
    ADD CONSTRAINT metric_import_developer_has_developer
        CHECK (kind <> 'developer' OR developer_id IS NOT NULL);

CREATE INDEX metric_import_developer_idx ON metric_import (developer_id, created_at DESC);

COMMENT ON COLUMN metric_import.developer_id IS
    'The developer whose metric this is. Required for developer-kind imports; null for bank imports, which hang off a site instead.';
