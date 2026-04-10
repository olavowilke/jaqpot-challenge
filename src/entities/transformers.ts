import type {ValueTransformer} from 'typeorm';

/**
 * Postgres BIGINT comes back as a string by default. All our amounts are
 * minor units (cents), which fit comfortably in a JS number, so we coerce
 * to/from number for ergonomics.
 */
export const bigintToNumber: ValueTransformer = {
    to: (v?: number | null) => v,
    from: (v?: string | null) => (v == null ? v : Number(v)),
};
