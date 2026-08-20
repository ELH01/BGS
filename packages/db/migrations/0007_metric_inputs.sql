-- The remaining metric inputs a stock parcel has to carry.
--
-- The workbook is where units are determined. It takes habitat type,
-- condition, strategic significance, extent and the temporal figures, and
-- computes the biodiversity units from them. This platform never calculates
-- units — it reads them from the bank's own metric and, when writing an
-- allocation into a developer's metric, writes back the inputs that reproduce
-- the same calculation.
--
-- That only works if every input is stored. Three were missing:
--
--   strategic_significance          a multiplier on the units a parcel yields
--   habitat_created_in_advance_years  reduces the temporal deduction
--   delay_years                     increases it
--
-- The temporal ones matter especially for a habitat bank, whose whole
-- proposition is habitat created ahead of need. Writing a bank parcel into a
-- developer's workbook with nothing in the created-in-advance column would have
-- that workbook compute fewer units than the habitat actually delivers, and the
-- developer would be short against a quote that looked correct.

CREATE TYPE strategic_significance_band AS ENUM (
    'formally-identified',
    'ecologically-desirable',
    'not-in-strategy'
);

ALTER TABLE stock_parcel
    ADD COLUMN strategic_significance strategic_significance_band;

-- Whole or part years; the metric accepts fractional values here.
ALTER TABLE stock_parcel
    ADD COLUMN habitat_created_in_advance_years numeric(6, 2);

ALTER TABLE stock_parcel
    ADD COLUMN delay_years numeric(6, 2);

ALTER TABLE stock_parcel
    ADD CONSTRAINT stock_parcel_advance_years_sane
        CHECK (habitat_created_in_advance_years IS NULL
               OR (habitat_created_in_advance_years >= 0 AND habitat_created_in_advance_years <= 100));

ALTER TABLE stock_parcel
    ADD CONSTRAINT stock_parcel_delay_years_sane
        CHECK (delay_years IS NULL OR (delay_years >= 0 AND delay_years <= 100));

COMMENT ON COLUMN stock_parcel.strategic_significance IS
    'Input to the metric''s unit calculation. Nullable so parcels recorded before this column existed remain readable, but a parcel cannot be written into a developer''s metric without it.';

COMMENT ON COLUMN stock_parcel.habitat_created_in_advance_years IS
    'Years the habitat was created ahead of the impact it compensates. Reduces the metric''s temporal deduction, so leaving it empty understates a banked parcel.';

COMMENT ON COLUMN stock_parcel.delay_years IS
    'Years before habitat creation starts. Normally zero for a bank parcel, whose habitat already exists.';
