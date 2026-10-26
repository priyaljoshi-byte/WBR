/**
 * pulse-extract - the only place the Anthropic key is allowed to exist.
 *
 * The browser sends a transcript and the open decision/blocker lists. This
 * function builds the prompt from transcript/extract.spec.md, calls the model,
 * validates the result against transcript/schema.js, and returns the extraction
 * object. The key never leaves the server.
 *
 * Deploy:
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *   supabase functions deploy pulse-extract
 *
 * ===========================================================================
 * STATUS: SKELETON. The Anthropic call is NOT implemented - see the TODO below.
 * Until it is, this returns 501 and the Add a meeting screen shows that as a
 * readable error. It does not fall back to anything, because a transcript
 * extractor that quietly invents a result is worse than one that is down.
 * ===========================================================================
 */

// @ts-nocheck  (Deno runtime; this file is not type-checked by the Node repo)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // The caller must be a signed-in user, not just anyone holding the anon key.
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'sign in first' }, 401);

  let input: any;
  try {
    input = await req.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }

  const transcript = String(input?.transcript || '');
  if (transcript.trim().length < 200) {
    return json({ error: 'that transcript is too short to extract anything from' }, 400);
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return json({
      error: 'ANTHROPIC_API_KEY is not set on this function. Run: supabase secrets set ANTHROPIC_API_KEY=...'
    }, 503);
  }

  // =========================================================================
  // TODO: THE ANTHROPIC CALL GOES HERE.
  //
  // What it must do, from transcript/extract.spec.md:
  //
  //  1. System prompt = the whole of extract.spec.md. Sections 0 through 9 are
  //     the contract; section 10 is the worked example and is load-bearing -
  //     it is what teaches the model that "the market is tough" is Context and
  //     not blocker number two.
  //
  //  2. The transcript goes in a USER message, inside a delimiter, introduced
  //     as data. Never concatenated into the system prompt. Section 0 of the
  //     spec is explicit: a line in the transcript addressed at the model is
  //     copied verbatim into `injectionAttempts` and otherwise ignored. Keeping
  //     it structurally separate from the instructions is what makes that
  //     instruction enforceable rather than aspirational.
  //
  //  3. `openDecisions` and `openBlockers` go in the same user message. They
  //     are what let the model return an `id` - and only an id finds a
  //     reversal, because a decision that genuinely changes rewrites its own
  //     headline and then scores far below the similarity threshold.
  //
  //  4. Ask for ONE JSON object, no prose, no markdown fence (spec section 9).
  //     Prefill the assistant turn with "{" to stop the model writing a preamble.
  //
  //  5. Validate the response against transcript/schema.js before returning it.
  //     An invalid extraction must 422 rather than reach the review screen,
  //     because a half-parsed decision is harder for a reviewer to catch than
  //     an obviously missing one.
  //
  //  6. Run the matcher: transcript/continuity.js matchDecisions() and
  //     transcript/blockers.js, so items in the grey band come back tagged
  //     `needs_human_merge` with their candidate attached. The review screen
  //     renders those side by side and refuses to commit until a human picks.
  //
  // Model: Deno.env.get('PULSE_EXTRACTION_MODEL') ?? a current Claude model id.
  // Check https://docs.claude.com/en/docs/about-claude/models for the id - do
  // not copy one from memory, they go stale.
  //
  // const res = await fetch('https://api.anthropic.com/v1/messages', {
  //   method: 'POST',
  //   headers: {
  //     'x-api-key': apiKey,
  //     'anthropic-version': '2023-06-01',
  //     'content-type': 'application/json'
  //   },
  //   body: JSON.stringify({
  //     model,
  //     max_tokens: 8192,
  //     system: EXTRACT_SPEC,
  //     messages: [
  //       { role: 'user', content: [
  //           { type: 'text', text: `<open_decisions>${JSON.stringify(input.openDecisions)}</open_decisions>` },
  //           { type: 'text', text: `<open_blockers>${JSON.stringify(input.openBlockers)}</open_blockers>` },
  //           { type: 'text', text: `<transcript>\n${transcript}\n</transcript>` }
  //       ] },
  //       { role: 'assistant', content: '{' }
  //     ]
  //   })
  // });
  // =========================================================================

  return json({
    error:
      'Transcript extraction is not wired up yet. The Anthropic call in '
      + 'supabase/functions/pulse-extract/index.ts is still a TODO. Nothing was written.'
  }, 501);
});
