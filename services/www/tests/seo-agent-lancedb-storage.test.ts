import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const r2 = vi.hoisted(() => ({ config: null as null | Record<string, unknown>, fail: false }));
vi.mock("@/lib/storage", async (orig) => ({
  ...(await orig<object>()),
  readR2Config: async () => {
    if (r2.fail) throw new Error("R2 is partly configured; missing R2_BUCKET");
    return r2.config;
  },
}));

const { handleCallback } = await import("@/lib/seo-agent/internal-server");

/** GET /internal/seo-agent/storage/lancedb (D-91, D-92): the agent's LanceDB connection from Admin → Storage. */
const CB = "c".repeat(40);
const env = { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB };
const get = (auth = `Bearer ${CB}`) => handleCallback("GET", "/internal/seo-agent/storage/lancedb", auth, undefined, env);

afterEach(() => {
  r2.config = null;
  r2.fail = false;
});

describe("LanceDB storage callback", () => {
  it("needs the callback token", async () => {
    r2.config = { bucket: "media", endpoint: "https://a.r2.cloudflarestorage.com", accessKeyId: "k", secretAccessKey: () => "s" };
    expect((await get("Bearer wrong")).status).toBe(401);
    expect((await get("")).status).toBe(401);
  });

  it("hands over the media bucket's prefix and keys once storage is set up", async () => {
    expect(await get()).toEqual({ status: 200, body: { configured: false } });
    r2.config = { bucket: "media", endpoint: "https://a.r2.cloudflarestorage.com", accessKeyId: "k", secretAccessKey: () => "s" };
    expect(await get()).toEqual({
      status: 200,
      body: { configured: true, uri: "s3://media/jithendar/seo-agent/lancedb", endpoint: "https://a.r2.cloudflarestorage.com", accessKeyId: "k", secretAccessKey: "s", region: "auto" },
    });
  });

  it("answers not configured, not 500, when the configuration cannot be read", async () => {
    r2.fail = true;
    expect(await get()).toEqual({ status: 200, body: { configured: false } });
  });
});
