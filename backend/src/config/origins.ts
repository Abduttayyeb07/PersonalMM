// The site's public origin (scheme + host [+ port]) is the single source of truth.
// ALLOWED_ORIGINS may list extra origins; it defaults to APP_ORIGIN.
export const DEFAULT_APP_ORIGIN = 'http://127.0.0.1:3070';

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.ALLOWED_ORIGINS || env.APP_ORIGIN || DEFAULT_APP_ORIGIN;
  return raw.split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean);
}

/** CORS origin callback evaluated per request, so it sees values loaded from .env at startup. */
export function corsOrigin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
  // Requests without an Origin header (curl, server-to-server) are not browser CORS requests.
  callback(null, !origin || allowedOrigins().includes(origin));
}
