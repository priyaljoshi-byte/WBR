/**
 * transcript-text.js - turn whatever file a person has into plain spoken text.
 *
 * Meeting tools export four things and people paste all four: a plain .txt, a
 * markdown .md, a WebVTT .vtt and a SubRip .srt. The last two are 80% timecodes
 * by volume. Feeding those to a model wastes tokens and, worse, gives it
 * thousands of numbers that are not metrics to trip over.
 *
 * This module is deliberately conservative: it strips only what is unambiguously
 * caption scaffolding. A line it is not sure about is kept, because losing a
 * sentence someone said is worse than keeping a stray cue number.
 *
 * No DOM here. Imported by both the page and node:test.
 */

const TIMECODE = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?/;
const CUE_NUMBER = /^\s*\d{1,5}\s*$/;
const VTT_HEADER = /^\s*WEBVTT/i;
const VTT_BLOCK = /^\s*(NOTE|STYLE|REGION)\b/;
// "[00:12:31] Dana:" and "00:12:31 Dana:" - a leading stamp on a spoken line.
const LEADING_STAMP = /^\s*[[(]?\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?\s*[\])]?\s*[-–—]?\s*/;

/**
 * @param {string} raw
 * @param {string} [filename]
 * @returns {{text: string, format: 'vtt'|'srt'|'text', strippedLines: number, lines: number}}
 */
export function cleanTranscript(raw, filename) {
  const src = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  const name = String(filename || '').toLowerCase();

  let format = 'text';
  if (VTT_HEADER.test(src) || name.endsWith('.vtt')) format = 'vtt';
  else if (name.endsWith('.srt')) format = 'srt';
  else if (TIMECODE.test(src) || src.split('\n').some((l) => TIMECODE.test(l))) format = 'srt';

  const lines = src.split('\n');
  const kept = [];
  let stripped = 0;
  let lastSpeakerLine = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (VTT_HEADER.test(line) || VTT_BLOCK.test(line)) { stripped += 1; continue; }
    if (TIMECODE.test(line)) { stripped += 1; continue; }

    // A bare number is a cue index only when a timecode follows it. In prose a
    // line that is just "220" could be somebody's number read out.
    if (CUE_NUMBER.test(line) && TIMECODE.test(lines[i + 1] || '')) { stripped += 1; continue; }

    let text = line
      .replace(/<\/?[cvbiu](?:\.[^>]*)?>/gi, '')       // <v Dana>, <c.colour>, <i>
      .replace(/<\/?\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/g, '') // inline karaoke stamps
      .replace(/^\s*<v\s+([^>]+)>/i, '$1: ');

    if (format !== 'text') text = text.replace(LEADING_STAMP, '');

    const trimmed = text.replace(/\s+$/, '');
    if (!trimmed.trim()) {
      // In a caption file a blank line is structure - it is what separates one
      // cue from the next - so it carries no meaning and dropping it is what
      // lets consecutive cues from one speaker be rejoined below. In prose a
      // blank line is a paragraph and it stays.
      if (format === 'text' && kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }

    // Caption files repeat a speaker label on every cue. Collapse the runs.
    const speaker = trimmed.match(/^([A-Z][\w .'-]{0,38}):\s*(.*)$/);
    if (speaker && speaker[1] === lastSpeakerLine && kept.length) {
      kept[kept.length - 1] = `${kept[kept.length - 1]} ${speaker[2]}`.trim();
      continue;
    }
    if (speaker) lastSpeakerLine = speaker[1];

    kept.push(trimmed.trim());
  }

  while (kept.length && kept[kept.length - 1] === '') kept.pop();

  return {
    text: kept.join('\n'),
    format,
    strippedLines: stripped,
    lines: kept.filter(Boolean).length
  };
}

/**
 * Lines in a transcript that are addressed at the model rather than at the room.
 *
 * This does NOT decide anything. It cannot: a transcript is a record of what
 * people said, and the only safe treatment is to show it to a human as a quote.
 * The extraction spec (transcript/extract.spec.md, section 0) says the same in
 * the model's own instructions; this is the client-side belt to that braces, so
 * a reviewer sees the line even if the model silently ignored it.
 *
 * @param {string} text
 * @returns {Array<{line:number, quote:string}>}
 */
export function suspectInjection(text) {
  const patterns = [
    /ignore (all )?(your |the )?(previous|prior|above) instructions?/i,
    /disregard (the |your )?(previous|prior|above|system)/i,
    /\byou are (now )?(an?|the) (ai|assistant|model|system)\b/i,
    /\b(mark|set) (everything|all|them all)\b.{0,24}\b(completed|approved|done|resolved)\b/i,
    /\bskip the (blockers?|decisions?|review|verification)\b/i,
    /\b(system|developer) (prompt|message)\b/i,
    /\boutput (nothing|only)\b/i,
    /\b(do not|don't) (flag|record|extract|report)\b/i,
    /\bthis is a test run\b.{0,30}\bskip\b/i
  ];
  const out = [];
  String(text || '').split('\n').forEach((line, i) => {
    if (patterns.some((p) => p.test(line))) out.push({ line: i + 1, quote: line.trim().slice(0, 400) });
  });
  return out;
}

export default cleanTranscript;
