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
 * Turn a Postgres error into a response the user can act on.
 *
 * The database carries real domain rules — precision scales, the quote status
 * ladder, tenant isolation — so its rejections are meaningful and worth
 * surfacing rather than collapsing into a generic 500.
 */
export function describeDatabaseError(error: unknown): { status: number; message: string } | null {
  const pgError = error as { code?: string; constraint?: string; message?: string };
  if (typeof pgError?.code !== 'string') return null;

  switch (pgError.code) {
    case '23505':
      return { status: 409, message: 'That already exists.' };
    case '23503':
      return { status: 400, message: 'That refers to something which does not exist.' };
    case '42501':
      return { status: 403, message: 'You do not have access to that.' };
    case '23514': {
      const constraint = pgError.constraint ?? '';
      if (constraint.includes('_scale')) {
        return {
          status: 400,
          message: 'A unit quantity was not at the correct precision for its module.',
        };
      }
      if (constraint.includes('retired_within_total')) {
        return { status: 400, message: 'Cannot retire more units than the parcel holds.' };
      }
      return { status: 400, message: pgError.message ?? 'That change breaks a rule on the data.' };
    }
    default:
      // Row-level security rejections arrive as 42501 above, but a policy
      // violation on write has its own code.
      if (pgError.message?.includes('row-level security')) {
        return { status: 403, message: 'You do not have access to that organisation.' };
      }
      return null;
  }
}
