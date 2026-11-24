import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/log";

vi.mock("server-only", () => ({}));

const { reportInvalidPost } = await import("@/lib/content/db-source");

afterEach(() => vi.restoreAllMocks());

describe("posts left out of the site because they do not validate", () => {
  it("logs a draft at debug (often incomplete on purpose) and a scheduled or published post as an error, once each", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const debug = vi.spyOn(log, "debug").mockImplementation(() => undefined);
    // Production 2026-11-24: a calendar draft without its description logged "invalid post skipped" on every request.
    for (let i = 0; i < 5; i++) reportInvalidPost("draft-1", "draft", ["Too small: expected string to have >=50 characters"]);
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) reportInvalidPost("live-1", "published", ["unknown author"]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("invalid post skipped", { postId: "live-1", status: "published", issues: ["unknown author"] });
    // A new problem on the same post is reported again.
    reportInvalidPost("live-1", "published", ["unknown author", "Invalid date"]);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
