/**
 * Environment-variable helpers.
 *
 * `requireEnv(name)` returns the value of `process.env[name]` or throws with a
 * clear, actionable error if it is missing or empty. Use this instead of the
 * non-null assertion `process.env.X!`, which silently casts to `string` and
 * lets `undefined` flow into downstream code (e.g. Supabase client init),
 * producing opaque stack traces far from the root cause.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in your deployment (Vercel project settings, .env.local, etc.).`
    );
  }
  return value;
}
