-- VAT belongs to the bank operator, not to the platform.
--
-- A quotation goes out under the operator whose stock it supplies, so it is
-- their VAT position that governs it. Cosdon may not be registered while a
-- client bank is, and the same platform has to produce a correct document
-- either way — which a single global setting cannot do.
--
-- Registration is explicit rather than inferred from the presence of a number:
-- "no number recorded yet" and "not registered" are different states, and
-- treating the first as the second would quietly drop VAT from a registered
-- operator's quote.

ALTER TABLE bank_operator
    ADD COLUMN vat_registered boolean NOT NULL DEFAULT false;

ALTER TABLE bank_operator
    ADD COLUMN vat_registration_number text;

-- Held per operator so a future change in rate, or an operator on a different
-- rate, does not need a code change.
ALTER TABLE bank_operator
    ADD COLUMN vat_rate_percent numeric(6, 3) NOT NULL DEFAULT 20;

-- Where payment should be sent. Separate from the branding address, which is
-- what appears at the top of the document: a registered office and a trading
-- address are often not the same, and an invoice needs the former.
ALTER TABLE bank_operator
    ADD COLUMN invoicing_address text;

ALTER TABLE bank_operator
    ADD CONSTRAINT bank_operator_vat_rate_sane
        CHECK (vat_rate_percent >= 0 AND vat_rate_percent <= 100);

-- A registered operator must say what its number is: a quote claiming VAT
-- without one is not a document anybody can act on.
ALTER TABLE bank_operator
    ADD CONSTRAINT bank_operator_registered_has_number
        CHECK (NOT vat_registered OR btrim(coalesce(vat_registration_number, '')) <> '');

COMMENT ON COLUMN bank_operator.vat_registered IS
    'Whether this operator charges VAT on unit sales. Governs the quote document, since the quote goes out under this operator.';
COMMENT ON COLUMN bank_operator.invoicing_address IS
    'Where payment is sent. Falls back to the branding address on documents when not set.';
