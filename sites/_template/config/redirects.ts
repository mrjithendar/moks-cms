/**
 * Permanent (308) redirects of this site, consumed by next.config.ts.
 * Every source must resolve in one hop: a destination may never be another source.
 */
export type Redirect = { source: string; destination: string };

export const redirects: Redirect[] = [];
