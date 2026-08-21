-- A quote supplies units from one bank operator.
--
-- Cosdon manages banks for several operators, and a quotation goes out under
-- the operator whose stock it draws on — their name, their branding, their
-- units. That operator may hold several sites, and a quote may draw from any of
-- them, but it does not straddle two operators: the resulting document would
-- have to claim to come from both.
--
-- Until now the supplying operator was inferred from whichever parcels happened
-- to be allocated, and a quote drawing on two was branded with whichever
-- supplied the most units. That is a guess standing in for a decision. Naming
-- the operator when the quote is created removes the guess, and lets the
-- allocation table show only the stock that quote can actually use.

ALTER TABLE quote
    ADD COLUMN bank_operator_id uuid REFERENCES bank_operator (id) ON DELETE RESTRICT;

-- Existing quotes: adopt the operator their allocation already draws on. Where
-- a quote has no lines, or straddles two operators, it is left null rather than
-- guessed at, and the application asks before it can be exported.
UPDATE quote q
   SET bank_operator_id = single.bank_operator_id
  FROM (
        -- The HAVING below guarantees exactly one, so taking the single
        -- aggregated value says what is meant. (There is no min() for uuid.)
        SELECT l.quote_id, (array_agg(DISTINCT s.bank_operator_id))[1] AS bank_operator_id
          FROM allocation_line l
          JOIN stock_parcel p ON p.id = l.stock_parcel_id
          JOIN habitat_bank_site s ON s.id = p.site_id
         GROUP BY l.quote_id
        HAVING count(DISTINCT s.bank_operator_id) = 1
       ) AS single
 WHERE single.quote_id = q.id;

CREATE INDEX quote_bank_operator_idx ON quote (bank_operator_id);

COMMENT ON COLUMN quote.bank_operator_id IS
    'The operator whose stock this quote supplies, and whose branding the document carries. Nullable only for quotes created before this column existed.';
