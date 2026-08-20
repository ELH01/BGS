import type { FastifyReply } from 'fastify';
import { ZodError, type ZodSchema } from 'zod';

/** Parse a request body, replying 400 with field-level detail on failure. */
export function parseBody<T>(schema: ZodSchema<T>, body: unknown, reply: FastifyReply): T | undefined {
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      void reply.code(400).send({
        error: 'The submitted data was not valid.',
        issues: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return undefined;
    }
    throw error;
  }
}

/**
 * Messages for the database constraints a user can actually do something
 * about, keyed by constraint name.
 *
 * Written here rather than forwarded from Postgres on purpose. Postgres's own
 * text names the table and the constraint, and its detail names the failing
 * row — which in this system means stock levels and negotiated pricing. None
 * of that should travel to a browser.
 */
const CONSTRAINT_MESSAGES: ReadonlyArray<[RegExp, string]> = [
  [/_scale$/, 'A unit quantity was not at the correct precision for its module.'],
  [/retired_within_total/, 'Cannot retire more units than the parcel holds.'],
  [/retired_units_non_negative/, 'That would restore more units than were retired.'],
  [/extent_positive_when_units_exist/, 'A parcel that generates units must have a positive extent.'],
  [/advance_years_sane|delay_years_sane/, 'Years must be between 0 and 100.'],
  [/accent_colour_hex/, 'The accent colour must be a hex value such as #385B4F.'],
  [/buffer_not_below_requirement/, 'The buffered target cannot be below the units required.'],
  [/shortfall_complete_or_absent/, 'Describe the habitat lost fully, or leave it out entirely.'],
  [/non_negative/, 'That figure cannot be negative.'],
  [/email_shape|email_lowercase/, 'That email address is not valid.'],
  [/slug_format/, 'The short name must be lower-case letters, numbers and hyphens.'],
  [/quote_prefix_format/, 'The quote prefix must start with a letter and be up to 12 characters.'],
  [/name_not_blank/, 'A name is required.'],
];

/**
 * Turn a Postgres error into a response the user can act on.
 *
 * Two kinds of rejection arrive here and they are treated differently.
 *
 * Rules this codebase wrote — the quote status ladder, the sold-allocation
 * guard — raise P0001 with a message composed for a person to read, and are
 * passed through as written.
 *
 * Everything Postgres itself rejects is answered with a message from the table
 * above, or a generic one. Its own text is never forwarded, because it
 * describes the data that failed.
 */
export function describeDatabaseError(error: unknown): { status: number; message: string } | null {
  const pgError = error as { code?: string; constraint?: string; message?: string };
  if (typeof pgError?.code !== 'string') return null;

  switch (pgError.code) {
    // plpgsql raise_exception: this codebase's own rules, written for a reader.
    case 'P0001':
      return {
        status: 409,
        message: (pgError.message ?? 'That is not allowed.').replace(/^.*?ERROR:\s*/, ''),
      };
    case '23505':
      return { status: 409, message: 'That already exists.' };
    case '23503':
      return { status: 400, message: 'That refers to something which does not exist.' };
    case '42501':
      return { status: 403, message: 'You do not have access to that.' };
    case '23514': {
      const constraint = pgError.constraint ?? '';
      for (const [pattern, message] of CONSTRAINT_MESSAGES) {
        if (pattern.test(constraint)) return { status: 400, message };
      }
      return { status: 400, message: 'That change breaks a rule on the data.' };
    }
    default:
      // A policy violation on write has its own wording rather than a code to
      // switch on.
      if (pgError.message?.includes('row-level security')) {
        return { status: 403, message: 'You do not have access to that organisation.' };
      }
      return null;
  }
}
