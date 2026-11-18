/**
 * Request bodies with a hard size limit.
 *
 * `await req.text()` buffers whatever the client sends; a length check after it only runs once the whole body is in
 * memory. On a public endpoint that is a cheap way to exhaust a pod. `readBodyText` stops reading (and cancels the
 * stream) as soon as the body is longer than allowed, and refuses up front when Content-Length already says so.
 *
 * Limits are in characters, as the callers' limits always were. UTF-8 needs at most three bytes per UTF-16 code unit,
 * so a text of `maxChars` characters can never be longer than `maxChars * 3` bytes: that is the cap while streaming,
 * and the decoded text is checked against `maxChars` at the end.
 */
export class BodyTooLarge extends Error {
  /** Route wrappers answer any error with a 4xx `status` with that status (lib/http-errors.ts). */
  readonly status = 413;
  readonly code = "too_large";
  constructor(readonly maxChars: number) {
    super("Request body too large.");
  }
}

export async function readBodyText(req: Request, maxChars: number): Promise<string> {
  const maxBytes = maxChars * 3;
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) throw new BodyTooLarge(maxChars);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new BodyTooLarge(maxChars);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  // Same decoding as Request.text(): UTF-8, a leading byte-order mark dropped.
  const text = new TextDecoder().decode(all);
  if (text.length > maxChars) throw new BodyTooLarge(maxChars);
  return text;
}

/** `readBodyText`, with "too large" as null so a route can answer it in its own format. */
export async function readBodyTextOrNull(req: Request, maxChars: number): Promise<string | null> {
  try {
    return await readBodyText(req, maxChars);
  } catch (error) {
    if (error instanceof BodyTooLarge) return null;
    throw error;
  }
}
