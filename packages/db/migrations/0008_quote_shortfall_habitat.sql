-- What was lost, per module, on a quote's requirement.
--
-- The trading rules decide which stock may lawfully fill a shortfall, and they
-- decide it from the habitat that was lost: its broad group, its specific type
-- and its distinctiveness. Without those, there is nothing to filter against.
--
-- On the solver-driven path this comes from the developer's metric. On the
-- manual path (§4.4) the user may not know it — an early enquiry might be no
-- more than "they need about five area units" — so all three are nullable.
-- When they are absent the platform shows all stock and says plainly that the
-- trading rules have not been applied, rather than quietly filtering on a
-- guess or quietly not filtering at all.

ALTER TABLE quote_module_target ADD COLUMN shortfall_broad_habitat text;
ALTER TABLE quote_module_target ADD COLUMN shortfall_habitat_type text;
ALTER TABLE quote_module_target ADD COLUMN shortfall_distinctiveness distinctiveness_band;

-- Either the habitat lost is described well enough to apply the rules, or it
-- is not described at all. A half-filled description would filter on partial
-- information and look authoritative doing it.
ALTER TABLE quote_module_target
    ADD CONSTRAINT quote_module_target_shortfall_complete_or_absent
        CHECK (
            (shortfall_broad_habitat IS NULL
             AND shortfall_habitat_type IS NULL
             AND shortfall_distinctiveness IS NULL)
            OR
            (shortfall_broad_habitat IS NOT NULL
             AND shortfall_habitat_type IS NOT NULL
             AND shortfall_distinctiveness IS NOT NULL)
        );

COMMENT ON COLUMN quote_module_target.shortfall_distinctiveness IS
    'Distinctiveness of the habitat lost, which sets how closely replacement stock must match. Null means the habitat lost was not described, so the trading rules cannot be applied.';
