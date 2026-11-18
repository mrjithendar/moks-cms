# RAG eval: token-hybrid-noid

- Date: 2026-11-10 · commit `8a5ca05` · embeddings `onnx:bge-small-en-v1.5` · full text: Postgres ts_rank (english)
- Corpus: 36 articles, 1790 chunks (chunker `token`, token counter `onnx:bge-small-en-v1.5`, longest embedded input 471 tokens, 0 over 512)
- Questions: 55 (8 no-answer), k = 6, configured floor 0.15
- Retrieval config: `mode=hybrid candidates=20 rrf_k=60 identifier_boost=0.0000 max_per_article=3`

| Recall@1 | Recall@3 | Recall@6 | MRR | Anchor hit | No-answer FP @ floor | Calibrated floor | No-answer FP @ calibrated | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| 95.7 | 95.7 | 100.0 | 0.968 | 89.4 | 100.0 | 0.66 | 62.5 | 6.7 | 7.44 |

## By question type

| Type | n | Recall@3 | MRR |
|---|---|---|---|
| concept | 14 | 92.9 | 0.946 |
| how-to | 12 | 100.0 | 1.000 |
| exact-term | 11 | 100.0 | 1.000 |
| troubleshooting | 10 | 90.0 | 0.925 |

## Floor table (cosine pre-filter)

| Floor | Expected answers lost | No-answer FP rate |
|---|---|---|
| 0.00 | 0 | 100.0 |
| 0.15 | 0 | 100.0 |
| 0.30 | 0 | 100.0 |
| 0.40 | 0 | 100.0 |
| 0.50 | 0 | 100.0 |
| 0.55 | 0 | 87.5 |
| 0.60 | 0 | 87.5 |
| 0.65 | 0 | 62.5 |
| 0.66 | 0 | 62.5 |
| 0.70 | 1 | 25.0 |

## Per question

| id | type | rank | anchor | best cos | top results |
|---|---|---|---|---|---|
| c01 | concept | 1 | ✓ | 0.800 | 15-essential-kubernetes-tools-devops-engineers-2026-part-1#helm-or-kustomize (0.80); python-vs-typescript#which-runtime-behaviors-differ (0.49); 15-essential-kubernetes-tools-devops-engineers-2026-part-1#4-kustomize-configuration-without-templates (0.73) |
| c02 | concept | 1 | ✓ | 0.834 | 15-essential-kubernetes-tools-devops-engineers-2026-part-2#9-keda-event-driven-autoscaling (0.83); python-vs-typescript#five-exercises (0.48); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#9-keda-event-driven-autoscaling (0.78) |
| c03 | concept | 1 | ✓ | 0.806 | cloudnativepg-postgres-cluster-minikube-terraform#44-one-database-and-one-role-per-application (0.81); cloudnativepg-postgres-cluster-minikube-terraform#what-we-had (0.79); cloudnativepg-postgres-cluster-minikube-terraform#6-moving-an-application-onto-the-cluster (0.77) |
| c04 | concept | 1 | ✓ | 0.768 | valkey-redis-sentinel-minikube-terraform#6-moving-the-applications (0.73); valkey-redis-sentinel-minikube-terraform#can-i-use-valkeyredissvc-instead-of-valkey-master (0.77); valkey-redis-sentinel-minikube-terraform#why-valkey-instead-of-redis (0.75) |
| c05 | concept | 1 | ✓ | 0.866 | fastapi-and-fastmcp-ai-projects#an-http-api-and-an-agent-tool-are-different-contracts (0.87); python-tutorial-beginners-real-projects#where-this-appears-in-moks-5 (0.67); devops-interview-preparation-guide#top-mcp-questions-and-model-answers (0.78) |
| c06 | concept | 1 |  | 0.840 | pytorch-rag-reranking-moks-sre-agent#what-the-model-is-not-allowed-to-override (0.83); pytorch-rag-reranking-moks-sre-agent#live-fallback-and-what-is-not-measured (0.84); pytorch-rag-reranking-moks-sre-agent#trade-offs (0.83) |
| c07 | concept | 1 | ✓ | 0.804 | kubernetes-history-origins-evolution-milestones#the-founders-and-the-codename (0.80); kubernetes-history-origins-evolution-milestones#the-founders-and-the-codename (0.78); kubernetes-history-origins-evolution-milestones#how-kubernetes-evolved-technically (0.76) |
| c08 | concept | 1 |  | 0.793 | moks-rag-and-skills-design#how-rag-works (0.77); moks-rag-and-skills-design# (0.79); moks-rag-and-skills-design#lifecycle (0.76) |
| c09 | concept | 1 |  | 0.823 | shell-scripting-vs-python#side-by-side-examples (0.82); shell-scripting-vs-python#quick-reference (0.82); shell-scripting-vs-python#what-do-shell-scripts-and-python-have-in-common (0.81) |
| c10 | concept | 1 | ✓ | 0.847 | roboshop-ai-gateway#how-it-differs-from-an-ingress-a-proxy-and-an-api-gateway (0.85); roboshop-ai-gateway#should-every-ai-application-have-a-gateway-like-this (0.78); roboshop-ai-gateway# (0.79) |
| c11 | concept | 1 | ✓ | 0.815 | system-design-evolution-1990s-to-microservices#monolith-or-microservices (0.78); system-design-evolution-1990s-to-microservices#monolithic-applications (0.75); system-design-evolution-1990s-to-microservices#monolith-or-microservices (0.70) |
| c12 | concept | 4 | ✓ | 0.846 | istio-service-mesh-minikube-features-setup-troubleshooting#1-what-a-service-mesh-is-and-why-istio (0.85); istio-service-mesh-minikube-features-setup-troubleshooting#5-on-my-cluster-the-istio-gateway-is-the-only-edge (0.75); istio-service-mesh-minikube-features-setup-troubleshooting#9-best-practices (0.74) |
| c13 | concept | 1 | ✓ | 0.900 | python-vs-typescript#why-none-is-not-the-same-as-null-and-undefined (0.90); python-vs-go-vs-typescript#python-none-go-nil-and-zero-values-javascript-null-and-undefined (0.79); python-vs-typescript#functions-and-return-values (0.83) |
| c14 | concept | 1 | ✓ | 0.781 | four-ai-systems-one-cluster#the-platform (0.78); four-ai-systems-one-cluster# (0.78); four-ai-systems-one-cluster#the-platform (0.71) |
| h01 | how-to | 1 | ✓ | 0.888 | github-actions-authenticate-minikube#1-the-short-version (0.85); github-actions-authenticate-minikube# (0.89); github-actions-authenticate-minikube#1-the-short-version (0.82) |
| h02 | how-to | 1 | ✓ | 0.807 | istio-service-mesh-minikube-features-setup-troubleshooting#6-mtls-and-authorization (0.78); istio-service-mesh-minikube-features-setup-troubleshooting#61-permissive-to-strict-without-guessing (0.81); istio-service-mesh-minikube-features-setup-troubleshooting#61-permissive-to-strict-without-guessing (0.76) |
| h03 | how-to | 1 | ✓ | 0.880 | cloudflare-turnstile-nextjs-bot-protection#path-1-the-contact-form (0.88); cloudflare-turnstile-nextjs-bot-protection#path-1-the-contact-form (0.86); cloudflare-turnstile-nextjs-bot-protection#path-1-the-contact-form (0.84) |
| h04 | how-to | 1 | ✓ | 0.868 | mermaid-diagrams-on-jithendar-com#step-2-draw-the-diagram-in-the-browser (0.87); mermaid-diagrams-on-jithendar-com#three-ways-to-render-mermaid (0.85); mermaid-diagrams-on-jithendar-com# (0.85) |
| h05 | how-to | 1 | ✓ | 0.796 | dependabot-setup-five-repositories#how-do-i-stop-getting-so-many-prs (0.80); dependabot-setup-five-repositories#will-grouping-hide-a-broken-update (0.72); dependabot-setup-five-repositories#code (0.71) |
| h06 | how-to | 1 |  | 0.890 | deploy-roboshop-ai-amazon-eks#troubleshooting (0.87); deploy-roboshop-ai-amazon-eks# (0.89); deploy-roboshop-ai-amazon-eks#prerequisites-and-tested-versions (0.85) |
| h07 | how-to | 1 | ✓ | 0.781 | cloudnativepg-postgres-cluster-minikube-terraform#how-do-i-rotate-an-applications-password (0.78); cloudnativepg-postgres-cluster-minikube-terraform#6-moving-an-application-onto-the-cluster (0.72); cloudnativepg-postgres-cluster-minikube-terraform#44-one-database-and-one-role-per-application (0.73) |
| h08 | how-to | 1 | ✓ | 0.824 | learning-typescript-real-project-jithendar-com#runtime-validation-with-zod (0.77); learning-typescript-real-project-jithendar-com#runtime-validation-with-zod (0.82); learning-typescript-real-project-jithendar-com#runtime-validation-with-zod (0.79) |
| h09 | how-to | 1 | ✓ | 0.820 | logging-tracing-observability-jithendar-com#initialization (0.76); logging-tracing-observability-jithendar-com#what-the-app-writes (0.74); logging-tracing-observability-jithendar-com#2-the-tools (0.82) |
| h10 | how-to | 1 | ✓ | 0.859 | fastapi-and-fastmcp-ai-projects#how-tools-are-registered (0.86); roboshop-ai-mcp-server#why-not-use-the-official-sdk-directly-instead-of-fastmcp (0.77); fastapi-and-fastmcp-ai-projects#how-tools-are-registered (0.77) |
| h11 | how-to | 1 | ✓ | 0.821 | devops-interview-preparation-guide#how-long-does-devops-interview-preparation-take (0.82); devops-interview-preparation-guide#a-7-week-roadmap (0.80); devops-interview-preparation-guide#how-to-use-this-devops-interview-preparation-guide (0.76) |
| h12 | how-to | 1 |  | 0.837 | kiali-minikube-service-mesh-observability#references (0.81); kiali-minikube-service-mesh-observability#summary (0.82); kiali-minikube-service-mesh-observability#troubleshooting-what-we-hit (0.81) |
| e01 | exact-term | 1 | ✓ | 0.796 | dependabot-setup-five-repositories#what-is-versioning-strategy-increase (0.80); dependabot-setup-five-repositories#do-i-need-dependabotyml-for-security-updates (0.76); dependabot-setup-five-repositories#2-the-three-dependabot-features (0.75) |
| e02 | exact-term | 1 | ✓ | 0.851 | shell-scripting-vs-python#set--e-set--u-and-set--o-pipefail-one-at-a-time (0.85); shell-scripting-vs-python#set--e-set--u-and-set--o-pipefail-one-at-a-time (0.85); shell-scripting-vs-python#set--e-set--u-and-set--o-pipefail-one-at-a-time (0.82) |
| e03 | exact-term | 1 | ✓ | 0.666 | istio-service-mesh-minikube-features-setup-troubleshooting#envoy-response-flags (0.67); istio-service-mesh-minikube-features-setup-troubleshooting#sources (0.64); istio-service-mesh-minikube-features-setup-troubleshooting#7-observability (0.60) |
| e04 | exact-term | 1 | ✓ | 0.914 | learning-terraform-real-project-tools-repository#sensitive--true-does-not-keep-a-value-out-of-state (0.91); learning-terraform-real-project-tools-repository#state-is-sensitive (0.85); learning-terraform-real-project-tools-repository#tfvars-files (0.79) |
| e05 | exact-term | 1 | ✓ | 0.845 | learning-terraform-real-project-tools-repository#refactoring-with-moved (0.85); learning-terraform-real-project-tools-repository#declaring-a-resource-does-not-adopt-an-existing-one (0.76); learning-terraform-real-project-tools-repository#removing-from-terraform-without-deleting-the-removed-block (0.75) |
| e06 | exact-term | 1 | ✓ | 0.819 | dependabot-setup-five-repositories#what-are-the-useful-pr-comment-commands (0.82); dependabot-setup-five-repositories#will-grouping-hide-a-broken-update (0.73); dependabot-setup-five-repositories#2-the-three-dependabot-features (0.73) |
| e07 | exact-term | 1 | ✓ | 0.721 | cloudnativepg-postgres-cluster-minikube-terraform#fatal-too-many-connections-for-role (0.72); roboshop-ai-gateway#timeouts-retries-and-overload (0.62); cloudnativepg-postgres-cluster-minikube-terraform#44-one-database-and-one-role-per-application (0.58) |
| e08 | exact-term | 1 | ✓ | 0.850 | learning-terraform-real-project-tools-repository#known-after-apply (0.85); learning-terraform-real-project-tools-repository#reading-a-plan (0.73); learning-terraform-real-project-tools-repository#reviewing-unexpected-changes (0.70) |
| e09 | exact-term | 1 | ✓ | 0.739 | valkey-redis-sentinel-minikube-terraform#can-i-use-valkeyredissvc-instead-of-valkey-master (0.69); valkey-redis-sentinel-minikube-terraform#oom-command-not-allowed-when-used-memory--maxmemory (0.74); valkey-redis-sentinel-minikube-terraform#43-memory-durability-and-a-shared-server (0.66) |
| e10 | exact-term | 1 | ✓ | 0.799 | shell-scripting-vs-python#why-shelltrue-and-eval-change-the-rules (0.80); shell-scripting-vs-python#leading-hyphens-and-where----helps (0.74); shell-scripting-vs-python#what-do-shell-scripts-and-python-have-in-common (0.75) |
| e11 | exact-term | 1 | ✓ | 0.797 | learning-terraform-real-project-tools-repository#import-adopting-something-that-already-exists (0.78); learning-terraform-real-project-tools-repository#file-names-are-only-conventions (0.78); learning-terraform-real-project-tools-repository#what-this-repository-actually-does (0.80) |
| t01 | troubleshooting | 4 | ✓ | 0.792 | deploy-roboshop-ai-amazon-eks#roll-back (0.71); deploy-roboshop-ai-amazon-eks#step-2-register-the-cluster-with-the-argo-cd-hub (0.69); deploy-roboshop-ai-amazon-eks#troubleshooting (0.68) |
| t02 | troubleshooting | 1 | ✓ | 0.790 | 15-essential-kubernetes-tools-devops-engineers-2026-part-2#istio-calls-fail-after-enabling-strict-mtls (0.79); istio-service-mesh-minikube-features-setup-troubleshooting#61-permissive-to-strict-without-guessing (0.78); istio-service-mesh-minikube-features-setup-troubleshooting#6-mtls-and-authorization (0.72) |
| t03 | troubleshooting | 1 | ✓ | 0.729 | cloudnativepg-postgres-cluster-minikube-terraform#an-application-breaks-behind-pgbouncer (0.73); cloudnativepg-postgres-cluster-minikube-terraform#why-session-mode-pgbouncer (0.63); pytorch-rag-reranking-moks-sre-agent#bounded-capacity-deadlines-and-cancellation (0.64) |
| t04 | troubleshooting | 1 | ✓ | 0.746 | valkey-redis-sentinel-minikube-terraform#queue-workers-or-subscribers-disconnect-every-30-seconds (0.75); valkey-redis-sentinel-minikube-terraform#54-the-failover-test (0.65); valkey-redis-sentinel-minikube-terraform#44-the-haproxy-post-renderer (0.65) |
| t05 | troubleshooting | 1 | ✓ | 0.821 | 15-essential-kubernetes-tools-devops-engineers-2026-part-2#karpenter-cannot-provision-nodes-for-pending-pods (0.82); roboshop-ai-eks-system-design#scaling-keda-for-pods-karpenter-for-nodes (0.74); roboshop-ai-eks-system-design#scaling-keda-for-pods-karpenter-for-nodes (0.72) |
| t06 | troubleshooting | 1 | ✓ | 0.781 | 15-essential-kubernetes-tools-devops-engineers-2026-part-2#cert-manager-fails-to-issue-or-renew-a-certificate (0.78); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#how-does-cert-manager-renew-certificates (0.76); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#13-cert-manager-certificate-lifecycle-automation (0.74) |
| t07 | troubleshooting | 1 | ✓ | 0.784 | roboshop-ai-gateway#chat-fails-with-503-feature-unavailable (0.78); roboshop-ai-gateway#timeouts-retries-and-overload (0.71); roboshop-ai-gateway#the-widget-returns-502-but-the-store-is-fine (0.75) |
| t08 | troubleshooting | 1 | ✓ | 0.858 | devops-interview-preparation-guide#scenario-a-rollout-is-stuck-and-pods-are-crash-looping (0.86); devops-interview-preparation-guide#scenario-a-rollout-is-stuck-and-pods-are-crash-looping (0.85); 15-essential-kubernetes-tools-devops-engineers-2026-part-1#helm-upgrade-blocked-by-a-stuck-release (0.71) |
| t09 | troubleshooting | 1 | ✓ | 0.854 | dependabot-setup-five-repositories#why-didnt-dependabot-open-a-pr-for-my-alert (0.85); dependabot-setup-five-repositories#can-dependabot-use-my-secrets-in-a-pr (0.72); dependabot-setup-five-repositories#how-i-triage-an-alert (0.73) |
| t10 | troubleshooting | 1 | ✓ | 0.844 | cloudnativepg-postgres-cluster-minikube-terraform#psql-fails-with-server-certificate-does-not-match-host-name (0.84); cloudnativepg-postgres-cluster-minikube-terraform#psql-says-invalid-connection-option-sslnegotiation-or-hangs-at-the-gateway (0.73); roboshop-ai-mcp-server#trust-boundaries-and-ai-specific-risks (0.48) |
| n01 | no-answer | — |  | 0.683 | roboshop-ai-gateway#provider-configuration-control-without-inference (0.63); roboshop-ai-eks-system-design#scaling-keda-for-pods-karpenter-for-nodes (0.65); roboshop-ai-gateway#provider-configuration-control-without-inference (0.63) |
| n02 | no-answer | — |  | 0.523 | valkey-redis-sentinel-minikube-terraform#8-best-practices-we-followed-and-what-is-next (0.50); shell-scripting-vs-python#running-an-external-command (0.52); istio-service-mesh-minikube-features-setup-troubleshooting#9-best-practices (0.46) |
| n03 | no-answer | — |  | 0.625 | cloudflare-turnstile-nextjs-bot-protection#using-the-component-in-a-form (0.63); deploy-roboshop-ai-amazon-eks#step-4-put-the-nlb-in-front-of-istio (0.54); cloudflare-turnstile-nextjs-bot-protection#rendering-the-widget-and-receiving-the-token (0.62) |
| n04 | no-answer | — |  | 0.702 | learning-typescript-real-project-jithendar-com#generics (0.70); roboshop-ai-mcp-server#unsafe-writes (0.56); learning-typescript-real-project-jithendar-com#api-requests-and-asynchronous-code (0.70) |
| n05 | no-answer | — |  | 0.706 | devops-interview-preparation-guide#top-ai-system-design-questions-and-model-answers (0.68); devops-interview-preparation-guide#top-ai-system-design-questions-and-model-answers (0.71); valkey-redis-sentinel-minikube-terraform#2-redis-cluster-but-not-redis-cluster (0.66) |
| n06 | no-answer | — |  | 0.630 | logging-tracing-observability-jithendar-com#6-metrics-dashboards-and-alerts (0.63); istio-service-mesh-minikube-features-setup-troubleshooting#9-best-practices (0.57); cloudflare-turnstile-nextjs-bot-protection#path-2-sign-in-and-sign-up-through-better-auth (0.60) |
| n07 | no-answer | — |  | 0.683 | learning-terraform-real-project-tools-repository#the-jenkins-alternative (0.66); dependabot-setup-five-repositories#checklist (0.65); github-actions-authenticate-minikube#8-a-catch-authenticated-is-not-the-same-as-deployed (0.68) |
| n08 | no-answer | — |  | 0.686 | moks-observability-logging-tracing-ai-agent-monitoring#how-it-was-deployed-and-what-was-verified (0.69); python-vs-go-vs-typescript#python-any-go-any-and-typescript-any-and-unknown (0.51); moks-observability-logging-tracing-ai-agent-monitoring#the-event-stream (0.68) |
