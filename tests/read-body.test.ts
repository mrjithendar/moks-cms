import { describe, expect, it } from "vitest";
import { BodyTooLarge, readBodyText, readBodyTextOrNull } from "@/lib/read-body";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://jithendar.com/api/ask", { method: "POST", headers, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);

/** A body that never ends: `pulled` counts the chunks the reader actually asked for. */
function endless(chunkBytes: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled++;
      controller.enqueue(new Uint8Array(chunkBytes).fill(97));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe("readBodyText", () => {
  it("returns the body as text, and an empty string when there is none", async () => {
    expect(await readBodyText(post(JSON.stringify({ question: "How does cert-manager renew?" })), 8000)).toBe('{"question":"How does cert-manager renew?"}');
    expect(await readBodyText(post(null), 8000)).toBe("");
    expect(await readBodyText(new Request("https://jithendar.com/api/ask"), 8000)).toBe("");
  });

  it("refuses a body longer than the limit with a 413", async () => {
    await expect(readBodyText(post("x".repeat(201)), 200)).rejects.toMatchObject({ status: 413, code: "too_large" });
    await expect(readBodyText(post("x".repeat(201)), 200)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(await readBodyText(post("x".repeat(200)), 200)).toHaveLength(200);
    expect(await readBodyTextOrNull(post("x".repeat(201)), 200)).toBeNull();
    expect(await readBodyTextOrNull(post("ok"), 200)).toBe("ok");
  });

  it("counts characters, not bytes: text in any script gets the same allowance", async () => {
    const telugu = "క".repeat(100); // 3 bytes each in UTF-8
    expect(await readBodyText(post(telugu), 100)).toBe(telugu);
    await expect(readBodyText(post(`${telugu}క`), 100)).rejects.toBeInstanceOf(BodyTooLarge);
    const emoji = "😀".repeat(50); // 4 bytes, 2 UTF-16 code units each
    expect(await readBodyText(post(emoji), 100)).toBe(emoji);
  });

  it("stops reading a body that never ends, and cancels the stream", async () => {
    const { stream, state } = endless(1024);
    await expect(readBodyText(post(stream), 1000)).rejects.toBeInstanceOf(BodyTooLarge);
    // 1000 characters = at most 3000 bytes: a handful of 1 KiB chunks, never the whole (infinite) body.
    expect(state.pulled).toBeLessThanOrEqual(8);
    expect(state.cancelled).toBe(true);
  });

  it("refuses up front when Content-Length already exceeds the limit", async () => {
    const { stream } = endless(1024);
    const req = { headers: new Headers({ "content-length": "5000000" }), body: stream } as unknown as Request;
    await expect(readBodyText(req, 1000)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(stream.locked).toBe(false); // the body was never opened
  });

  it("passes other stream errors through unchanged", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("connection reset");
      },
    });
    await expect(readBodyTextOrNull(post(broken), 1000)).rejects.toThrow("connection reset");
  });
});
