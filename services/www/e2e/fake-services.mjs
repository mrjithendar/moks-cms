// Fake Anthropic Messages API + fake IndexNow endpoint for local E2E runs (never used in production).
//   node e2e/fake-services.mjs   (port 3199)
// App env: ANTHROPIC_BASE_URL=http://localhost:3199  ANTHROPIC_API_KEY=sk-ant-fake  INDEXNOW_ENDPOINT=http://localhost:3199/indexnow
// GET /__calls returns what was received, so the E2E test can assert on it.
import http from "node:http";

const calls = [];
const TITLE = "Ingress and TLS on Kubernetes: a worked example";
const META = "How to terminate TLS at a Kubernetes ingress controller with cert-manager, with a worked example and the failure modes to check first.";

function changeSet() {
  return JSON.stringify({
    summary: "Tightens the search title and meta description and clarifies one sentence (E2E fake).",
    changes: [
      { type: "title", block_id: "", before: TITLE, after: "Kubernetes ingress TLS with cert-manager", rationale: "Leads with the searched phrase (fixture evidence).", evidence_ref: [], source_urls: [] },
      { type: "meta_description", block_id: "", before: META, after: "Terminate TLS at a Kubernetes ingress with cert-manager: Helm install, ClusterIssuer setup, renewal, and the DNS and HTTP-01 failures to check first.", rationale: "States what the reader gets in under 155 characters.", evidence_ref: [], source_urls: [] },
      { type: "paragraph_edit", block_id: "b2", before: "Install it with Helm.", after: "Install the ingress-nginx controller with Helm.", rationale: "Names what is installed.", evidence_ref: [], source_urls: [] },
      { type: "heading", block_id: "b5", before: "Terminate TLS", after: "Terminate TLS with cert-manager", rationale: "Matches the query wording.", evidence_ref: [], source_urls: [] },
    ],
  });
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      calls.push({ path, method: req.method, at: new Date().toISOString(), body: body ? JSON.parse(body) : null });
      if (path === "/__calls") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(calls.filter((c) => c.path !== "/__calls")));
      if (path === "/indexnow") return res.writeHead(202).end();
      if (path === "/v1/messages" && req.method === "POST") {
        const msg = { id: `msg_${calls.length}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: changeSet() }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3200, output_tokens: 600, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 } };
        return res.writeHead(200, { "content-type": "application/json", "request-id": `req_fake_${calls.length}` }).end(JSON.stringify(msg));
      }
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: path } }));
    });
  })
  .listen(3199, () => console.log("fake services on :3199"));
