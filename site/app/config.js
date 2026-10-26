/**
 * config.js - the two public addresses this app needs, and nothing else.
 *
 * NOTHING IN THIS FILE IS A SECRET, and nothing that is a secret may ever be
 * added to it. Every byte here is served to the browser.
 *
 *   - SUPABASE_ANON_KEY is public by design. It is a storefront address, not a
 *     key to the building. The actual gate is Row Level Security in
 *     supabase/schema.sql, keyed off the verified Google sign-in.
 *   - GOOGLE_CLIENT_ID is public by design, same as in shopos-org-KPIs.
 *   - ANTHROPIC_API_KEY is NOT public and must never appear here. The transcript
 *     extraction runs in a Supabase Edge Function so the key stays server-side.
 *     See app/api.js and supabase/functions/pulse-extract/.
 *
 * Same Supabase project and the same Google client as shopos-org-KPIs, so nobody
 * gets a second login and department ids stay in lockstep with the org chart.
 */
export const PULSE_CONFIG = {
  GOOGLE_CLIENT_ID: '173733749755-s8b6ogjbo4cg5r9iko0l399lmgeamrci.apps.googleusercontent.com',
  ALLOWED_HOSTED_DOMAIN: 'shopos.ai',
  ALLOWED_EMAILS: [],
  SESSION_DAYS: 7,

  SUPABASE_URL: 'https://ypuinaryddkudzrkfusm.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_EaE_VXFm2NnkdA06hsRZug_rjnvWUCN',

  /** The Edge Function that holds the Anthropic key. Deployed separately. */
  EXTRACT_FUNCTION: 'pulse-extract',

  /**
   * The address a department head shares their sheet with. Not a credential -
   * it is the service account's email, the same way you would share with a
   * colleague. The private key for it lives in the server's .env only.
   * TODO: replace once the Google service account exists (see .env.example).
   */
  SERVICE_ACCOUNT_EMAIL: 'pulse@your-project.iam.gserviceaccount.com',

  /** Where config/*.json is served from, relative to app/. */
  CONFIG_BASE: '../config'
};

export default PULSE_CONFIG;
