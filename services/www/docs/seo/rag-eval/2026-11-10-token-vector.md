# RAG eval: token-vector

- Date: 2026-11-10 · commit `8a5ca05` · embeddings `onnx:bge-small-en-v1.5` · full text: none (vector only)
- Corpus: 36 articles, 1790 chunks (chunker `token`, token counter `onnx:bge-small-en-v1.5`, longest embedded input 471 tokens, 0 over 512)
- Questions: 55 (8 no-answer), k = 6, configured floor 0.15
- Retrieval config: `mode=vector candidates=20 rrf_k=60 identifier_boost=0.0164 max_per_article=0`

| Recall@1 | Recall@3 | Recall@6 | MRR | Anchor hit | No-answer FP @ floor | Calibrated floor | No-answer FP @ calibrated | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| 93.6 | 100.0 | 100.0 | 0.968 | 97.9 | 100.0 | 0.66 | 62.5 | 0.63 | 0.66 |

## By question type

| Type | n | Recall@3 | MRR |
|---|---|---|---|
| concept | 14 | 100.0 | 0.929 |
| how-to | 12 | 100.0 | 0.958 |
| exact-term | 11 | 100.0 | 1.000 |
| troubleshooting | 10 | 100.0 | 1.000 |

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
| c01 | concept | 1 | ✓ | 0.800 | 15-essential-kubernetes-tools-devops-engineers-2026-part-1#helm-or-kustomize (0.80); 15-essential-kubernetes-tools-devops-engineers-2026-part-1#4-kustomize-configuration-without-templates (0.73); 15-essential-kubernetes-tools-devops-engineers-2026-part-1#1-helm-the-kubernetes-package-manager (0.71) |
| c02 | concept | 1 | ✓ | 0.834 | 15-essential-kubernetes-tools-devops-engineers-2026-part-2#9-keda-event-driven-autoscaling (0.83); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#9-keda-event-driven-autoscaling (0.78); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#keda-or-hpa (0.73) |
| c03 | concept | 1 | ✓ | 0.825 | cloudnativepg-postgres-cluster-minikube-terraform#what-we-wanted (0.83); cloudnativepg-postgres-cluster-minikube-terraform#44-one-database-and-one-role-per-application (0.81); cloudnativepg-postgres-cluster-minikube-terraform#what-we-had (0.79) |
| c04 | concept | 1 | ✓ | 0.768 | valkey-redis-sentinel-minikube-terraform#can-i-use-valkeyredissvc-instead-of-valkey-master (0.77); valkey-redis-sentinel-minikube-terraform#why-valkey-instead-of-redis (0.75); valkey-redis-sentinel-minikube-terraform#6-moving-the-applications (0.73) |
| c05 | concept | 1 | ✓ | 0.866 | fastapi-and-fastmcp-ai-projects#an-http-api-and-an-agent-tool-are-different-contracts (0.87); devops-interview-preparation-guide#top-mcp-questions-and-model-answers (0.78); roboshop-ai-mcp-server#mcp-in-plain-language (0.74) |
| c06 | concept | 1 | ✓ | 0.840 | pytorch-rag-reranking-moks-sre-agent#live-fallback-and-what-is-not-measured (0.84); pytorch-rag-reranking-moks-sre-agent#evaluation-and-results (0.84); pytorch-rag-reranking-moks-sre-agent#where-pytorch-fits (0.83) |
| c07 | concept | 1 | ✓ | 0.804 | kubernetes-history-origins-evolution-milestones#the-founders-and-the-codename (0.80); kubernetes-history-origins-evolution-milestones#lessons-not-a-code-dump (0.80); kubernetes-history-origins-evolution-milestones#the-founders-and-the-codename (0.78) |
| c08 | concept | 1 | ✓ | 0.793 | moks-rag-and-skills-design# (0.79); moks-rag-and-skills-design#the-short-version (0.78); moks-rag-and-skills-design#how-rag-works (0.77) |
| c09 | concept | 1 | ✓ | 0.846 | shell-scripting-vs-python#what-do-shell-scripts-and-python-have-in-common (0.85); shell-scripting-vs-python#shell-scripting-vs-python-the-short-answer (0.84); shell-scripting-vs-python#quick-reference (0.84) |
| c10 | concept | 1 | ✓ | 0.847 | roboshop-ai-gateway#how-it-differs-from-an-ingress-a-proxy-and-an-api-gateway (0.85); four-ai-systems-one-cluster#the-ai-gateway (0.82); roboshop-ai-gateway# (0.80) |
| c11 | concept | 2 | ✓ | 0.815 | system-design-evolution-cloud-native-ai-2026#is-a-monolith-still-a-good-choice-in-2026 (0.82); system-design-evolution-1990s-to-microservices#monolith-or-microservices (0.78); system-design-evolution-1990s-to-microservices#monolithic-applications (0.75) |
| c12 | concept | 2 | ✓ | 0.846 | istio-service-mesh-minikube-features-setup-troubleshooting#1-what-a-service-mesh-is-and-why-istio (0.85); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#istio-or-linkerd (0.83); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#11-linkerd-the-lightweight-service-mesh (0.80) |
| c13 | concept | 1 | ✓ | 0.900 | python-vs-typescript#why-none-is-not-the-same-as-null-and-undefined (0.90); python-vs-typescript#functions-and-return-values (0.83); learning-typescript-real-project-jithendar-com#null-undefined-and-unions (0.82) |
| c14 | concept | 1 | ✓ | 0.781 | four-ai-systems-one-cluster# (0.78); four-ai-systems-one-cluster#the-platform (0.78); four-ai-systems-one-cluster#shared-patterns (0.76) |
| h01 | how-to | 1 | ✓ | 0.888 | github-actions-authenticate-minikube# (0.89); github-actions-authenticate-minikube#10-what-i-would-change-next (0.85); github-actions-authenticate-minikube#1-the-short-version (0.85) |
| h02 | how-to | 1 | ✓ | 0.807 | istio-service-mesh-minikube-features-setup-troubleshooting#61-permissive-to-strict-without-guessing (0.81); istio-service-mesh-minikube-features-setup-troubleshooting#conclusion (0.79); istio-service-mesh-minikube-features-setup-troubleshooting#9-best-practices (0.79) |
| h03 | how-to | 1 | ✓ | 0.880 | cloudflare-turnstile-nextjs-bot-protection#path-1-the-contact-form (0.88); cloudflare-turnstile-nextjs-bot-protection# (0.87); cloudflare-turnstile-nextjs-bot-protection#path-1-the-contact-form (0.87) |
| h04 | how-to | 1 | ✓ | 0.868 | mermaid-diagrams-on-jithendar-com#step-2-draw-the-diagram-in-the-browser (0.87); mermaid-diagrams-on-jithendar-com#three-ways-to-render-mermaid (0.86); mermaid-diagrams-on-jithendar-com#three-ways-to-render-mermaid (0.85) |
| h05 | how-to | 1 | ✓ | 0.796 | dependabot-setup-five-repositories#how-do-i-stop-getting-so-many-prs (0.80); dependabot-setup-five-repositories#will-grouping-hide-a-broken-update (0.72); dependabot-setup-five-repositories#1-what-i-have-running (0.72) |
| h06 | how-to | 1 | ✓ | 0.890 | deploy-roboshop-ai-amazon-eks# (0.89); deploy-roboshop-ai-amazon-eks#prerequisites-and-tested-versions (0.88); deploy-roboshop-ai-amazon-eks#troubleshooting (0.87) |
| h07 | how-to | 1 | ✓ | 0.781 | cloudnativepg-postgres-cluster-minikube-terraform#how-do-i-rotate-an-applications-password (0.78); cloudnativepg-postgres-cluster-minikube-terraform#44-one-database-and-one-role-per-application (0.76); cloudnativepg-postgres-cluster-minikube-terraform#44-one-database-and-one-role-per-application (0.73) |
| h08 | how-to | 1 | ✓ | 0.824 | learning-typescript-real-project-jithendar-com#runtime-validation-with-zod (0.82); learning-typescript-real-project-jithendar-com#what-typescript-is-and-what-it-is-not (0.81); learning-typescript-real-project-jithendar-com#declaring-a-type-is-not-checking-the-data (0.81) |
| h09 | how-to | 1 | ✓ | 0.820 | logging-tracing-observability-jithendar-com#2-the-tools (0.82); logging-tracing-observability-jithendar-com#across-the-one-internal-service-boundary (0.79); logging-tracing-observability-jithendar-com#initialization (0.77) |
| h10 | how-to | 1 | ✓ | 0.859 | fastapi-and-fastmcp-ai-projects#how-tools-are-registered (0.86); roboshop-ai-mcp-server#why-not-use-the-official-sdk-directly-instead-of-fastmcp (0.77); fastapi-and-fastmcp-ai-projects#how-tools-are-registered (0.77) |
| h11 | how-to | 1 | ✓ | 0.821 | devops-interview-preparation-guide#how-long-does-devops-interview-preparation-take (0.82); devops-interview-preparation-guide#a-7-week-roadmap (0.80); devops-interview-preparation-guide#how-to-use-this-devops-interview-preparation-guide (0.76) |
| h12 | how-to | 2 |  | 0.837 | istio-service-mesh-minikube-features-setup-troubleshooting# (0.84); kiali-minikube-service-mesh-observability#summary (0.82); kiali-minikube-service-mesh-observability#our-environment (0.81) |
| e01 | exact-term | 1 | ✓ | 0.796 | dependabot-setup-five-repositories#what-is-versioning-strategy-increase (0.80); dependabot-setup-five-repositories#do-i-need-dependabotyml-for-security-updates (0.76); dependabot-setup-five-repositories#1-what-i-have-running (0.75) |
| e02 | exact-term | 1 | ✓ | 0.851 | shell-scripting-vs-python#set--e-set--u-and-set--o-pipefail-one-at-a-time (0.85); shell-scripting-vs-python#set--e-set--u-and-set--o-pipefail-one-at-a-time (0.85); shell-scripting-vs-python#set--e-set--u-and-set--o-pipefail-one-at-a-time (0.82) |
| e03 | exact-term | 1 | ✓ | 0.666 | istio-service-mesh-minikube-features-setup-troubleshooting#envoy-response-flags (0.67); istio-service-mesh-minikube-features-setup-troubleshooting#sources (0.64); istio-service-mesh-minikube-features-setup-troubleshooting#7-observability (0.60) |
| e04 | exact-term | 1 | ✓ | 0.914 | learning-terraform-real-project-tools-repository#sensitive--true-does-not-keep-a-value-out-of-state (0.91); learning-terraform-real-project-tools-repository#state-is-sensitive (0.85); learning-terraform-real-project-tools-repository#what-this-repository-actually-does (0.79) |
| e05 | exact-term | 1 | ✓ | 0.845 | learning-terraform-real-project-tools-repository#refactoring-with-moved (0.85); learning-terraform-real-project-tools-repository#import-adopting-something-that-already-exists (0.76); learning-terraform-real-project-tools-repository#locals-name-a-value-once (0.76) |
| e06 | exact-term | 1 | ✓ | 0.819 | dependabot-setup-five-repositories#what-are-the-useful-pr-comment-commands (0.82); dependabot-setup-five-repositories#12-recap (0.76); dependabot-setup-five-repositories#will-grouping-hide-a-broken-update (0.73) |
| e07 | exact-term | 1 | ✓ | 0.721 | cloudnativepg-postgres-cluster-minikube-terraform#fatal-too-many-connections-for-role (0.72); roboshop-ai-gateway#timeouts-retries-and-overload (0.62); devops-interview-preparation-guide#scenario-an-agent-closed-40-tickets-after-reading-one (0.62) |
| e08 | exact-term | 1 | ✓ | 0.850 | learning-terraform-real-project-tools-repository#known-after-apply (0.85); learning-terraform-real-project-tools-repository#reading-a-plan (0.73); learning-terraform-real-project-tools-repository#the-full-sequence (0.72) |
| e09 | exact-term | 1 | ✓ | 0.739 | valkey-redis-sentinel-minikube-terraform#oom-command-not-allowed-when-used-memory--maxmemory (0.74); valkey-redis-sentinel-minikube-terraform#43-memory-durability-and-a-shared-server (0.71); valkey-redis-sentinel-minikube-terraform#45-one-acl-user-and-database-range-per-application (0.69) |
| e10 | exact-term | 1 | ✓ | 0.810 | shell-scripting-vs-python#subprocessrun-with-an-argument-list (0.81); shell-scripting-vs-python#why-shelltrue-and-eval-change-the-rules (0.80); shell-scripting-vs-python#functions (0.77) |
| e11 | exact-term | 1 | ✓ | 0.811 | learning-terraform-real-project-tools-repository#where-values-come-from-and-which-wins (0.81); learning-terraform-real-project-tools-repository#what-this-repository-actually-does (0.80); learning-terraform-real-project-tools-repository#import-adopting-something-that-already-exists (0.78) |
| t01 | troubleshooting | 1 | ✓ | 0.792 | 15-essential-kubernetes-tools-devops-engineers-2026-part-1#2-argo-cd-gitops-continuous-delivery (0.79); 15-essential-kubernetes-tools-devops-engineers-2026-part-1#argo-cd-application-is-outofsync (0.79); kiali-minikube-service-mesh-observability#our-environment (0.71) |
| t02 | troubleshooting | 1 | ✓ | 0.790 | 15-essential-kubernetes-tools-devops-engineers-2026-part-2#istio-calls-fail-after-enabling-strict-mtls (0.79); istio-service-mesh-minikube-features-setup-troubleshooting#61-permissive-to-strict-without-guessing (0.78); istio-service-mesh-minikube-features-setup-troubleshooting#62-authorizationpolicy-dry-run-first (0.76) |
| t03 | troubleshooting | 1 | ✓ | 0.729 | cloudnativepg-postgres-cluster-minikube-terraform#an-application-breaks-behind-pgbouncer (0.73); pytorch-rag-reranking-moks-sre-agent#bounded-capacity-deadlines-and-cancellation (0.64); cloudnativepg-postgres-cluster-minikube-terraform#why-session-mode-pgbouncer (0.63) |
| t04 | troubleshooting | 1 | ✓ | 0.746 | valkey-redis-sentinel-minikube-terraform#queue-workers-or-subscribers-disconnect-every-30-seconds (0.75); valkey-redis-sentinel-minikube-terraform#53-what-healthy-looks-like (0.67); valkey-redis-sentinel-minikube-terraform#42-topology-persistence-and-failover (0.66) |
| t05 | troubleshooting | 1 | ✓ | 0.821 | 15-essential-kubernetes-tools-devops-engineers-2026-part-2#karpenter-cannot-provision-nodes-for-pending-pods (0.82); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#8-karpenter-just-in-time-nodes (0.78); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#8-karpenter-just-in-time-nodes (0.78) |
| t06 | troubleshooting | 1 | ✓ | 0.781 | 15-essential-kubernetes-tools-devops-engineers-2026-part-2#cert-manager-fails-to-issue-or-renew-a-certificate (0.78); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#how-does-cert-manager-renew-certificates (0.76); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#13-cert-manager-certificate-lifecycle-automation (0.74) |
| t07 | troubleshooting | 1 | ✓ | 0.784 | roboshop-ai-gateway#chat-fails-with-503-feature-unavailable (0.78); roboshop-ai-gateway#the-widget-returns-502-but-the-store-is-fine (0.75); roboshop-ai-gateway#following-one-chat-request (0.73) |
| t08 | troubleshooting | 1 | ✓ | 0.858 | devops-interview-preparation-guide#scenario-a-rollout-is-stuck-and-pods-are-crash-looping (0.86); devops-interview-preparation-guide#scenario-a-rollout-is-stuck-and-pods-are-crash-looping (0.85); devops-interview-preparation-guide#top-kubernetes-questions-and-model-answers (0.81) |
| t09 | troubleshooting | 1 | ✓ | 0.854 | dependabot-setup-five-repositories#why-didnt-dependabot-open-a-pr-for-my-alert (0.85); dependabot-setup-five-repositories#what-happened-this-week (0.74); dependabot-setup-five-repositories#how-i-triage-an-alert (0.73) |
| t10 | troubleshooting | 1 | ✓ | 0.844 | cloudnativepg-postgres-cluster-minikube-terraform#psql-fails-with-server-certificate-does-not-match-host-name (0.84); cloudnativepg-postgres-cluster-minikube-terraform#psql-says-invalid-connection-option-sslnegotiation-or-hangs-at-the-gateway (0.73); cloudnativepg-postgres-cluster-minikube-terraform#postgres-answers-rbac-access-denied-or-psql-is-cut-off-immediately (0.72) |
| n01 | no-answer | — |  | 0.683 | 15-essential-kubernetes-tools-devops-engineers-2026-part-2#9-keda-event-driven-autoscaling (0.68); 15-essential-kubernetes-tools-devops-engineers-2026-part-2#9-keda-event-driven-autoscaling (0.65); roboshop-ai-eks-system-design#scaling-keda-for-pods-karpenter-for-nodes (0.65) |
| n02 | no-answer | — |  | 0.523 | shell-scripting-vs-python#running-an-external-command (0.52); shell-scripting-vs-python#standard-output-versus-standard-error (0.52); shell-scripting-vs-python#2-the-jithendarcom-smoke-test-bash (0.52) |
| n03 | no-answer | — |  | 0.625 | cloudflare-turnstile-nextjs-bot-protection#using-the-component-in-a-form (0.63); cloudflare-turnstile-nextjs-bot-protection#rendering-the-widget-and-receiving-the-token (0.62); cloudflare-turnstile-nextjs-bot-protection#2-what-cloudflare-turnstile-is (0.61) |
| n04 | no-answer | — |  | 0.702 | learning-typescript-real-project-jithendar-com#generics (0.70); learning-typescript-real-project-jithendar-com#api-requests-and-asynchronous-code (0.70); learning-typescript-real-project-jithendar-com#api-requests-and-asynchronous-code (0.70) |
| n05 | no-answer | — |  | 0.706 | devops-interview-preparation-guide#top-ai-system-design-questions-and-model-answers (0.71); pytorch-rag-reranking-moks-sre-agent#moks-integration-and-fallback (0.70); pytorch-rag-reranking-moks-sre-agent#kubernetes-deployment (0.69) |
| n06 | no-answer | — |  | 0.630 | logging-tracing-observability-jithendar-com#6-metrics-dashboards-and-alerts (0.63); cloudflare-turnstile-nextjs-bot-protection#path-2-sign-in-and-sign-up-through-better-auth (0.60); kiali-minikube-service-mesh-observability#tracing-wizards-and-ambient-mode (0.60) |
| n07 | no-answer | — |  | 0.683 | github-actions-authenticate-minikube#6-getting-the-values-into-github (0.68); github-actions-authenticate-minikube#8-a-catch-authenticated-is-not-the-same-as-deployed (0.68); github-actions-authenticate-minikube#10-what-i-would-change-next (0.68) |
| n08 | no-answer | — |  | 0.686 | moks-observability-logging-tracing-ai-agent-monitoring#how-it-was-deployed-and-what-was-verified (0.69); moks-observability-logging-tracing-ai-agent-monitoring#the-event-stream (0.68); moks-observability-logging-tracing-ai-agent-monitoring#structured-logging-and-correlation (0.68) |
