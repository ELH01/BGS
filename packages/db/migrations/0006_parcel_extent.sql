-- Physical extent of a stock parcel.
--
-- Needed for the off-site metric write-back (§4.7). The metric's input sheets
-- do not take biodiversity units: they take an area in hectares, or a length
-- in kilometres, and compute the units themselves from distinctiveness,
-- condition, significance and the spatial multiplier.
--
-- So writing an allocation of 2.3457 units back into a developer's workbook
-- means writing the extent that produces those units:
--
--   written extent = allocated units x parcel extent / parcel total units
--
-- which is simply the fraction of the parcel being sold applied to its size.
-- Without the extent recorded, that fraction cannot be turned back into the
-- hectares or kilometres the workbook is asking for.
--
-- Deliberately a separate precision system again from both unit quantities and
-- money: this is a physical measurement carried at the precision the source
-- metric stated it to, and it is never summed with unit quantities.

ALTER TABLE stock_parcel
    ADD COLUMN extent numeric(18, 6);

ALTER TABLE stock_parcel
    ADD CONSTRAINT stock_parcel_extent_non_negative
        CHECK (extent IS NULL OR extent >= 0);

-- A parcel that generates units must have a non-zero extent for the fraction
-- above to be meaningful; a zero extent with positive units would make the
-- write-back divide sensibly but describe an impossible parcel.
ALTER TABLE stock_parcel
    ADD CONSTRAINT stock_parcel_extent_positive_when_units_exist
        CHECK (extent IS NULL OR extent > 0 OR total_units = 0);

COMMENT ON COLUMN stock_parcel.extent IS
    'Hectares for the area module, kilometres for hedgerow and watercourse. Nullable: parcels entered before the metric write-back existed have none, and cannot be written back until one is supplied.';
