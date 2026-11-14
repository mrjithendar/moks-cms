"""The worker Deployment is the web Deployment with a different job, not a second configuration to maintain.

  python3 -m unittest discover -s scripts/tests -p 'test_*.py'      (needs PyYAML)

minikube/35-jithendar-com-worker.yaml repeats the pod of minikube/30-jithendar-com.yaml. These tests fail when the
two drift apart (an environment variable or a mount added to one only), and when something that has to know both
kinds of pod (network policies, the metrics Service, the CI deployer's Role) knows only one.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import yaml

MINIKUBE = Path(__file__).resolve().parents[2] / "minikube"
# Set on the web replicas only, on purpose. Anything else must be on both.
#   TRUSTED_EDGE  which proxy's client-address headers to believe; the worker serves no visitors
WEB_ONLY_ENV = {"TRUSTED_EDGE"}
BOTH = ["jithendar-com", "jithendar-com-worker"]


def load(name: str) -> list[dict]:
    return [d for d in yaml.safe_load_all((MINIKUBE / name).read_text()) if d]


def find(docs: list[dict], kind: str, name: str) -> dict:
    return next(d for d in docs if d["kind"] == kind and d["metadata"]["name"] == name)


def selects_both(selector: dict) -> bool:
    return any(e == {"key": "app", "operator": "In", "values": BOTH} for e in selector.get("matchExpressions", []))


class WorkerDeployment(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.site = load("30-jithendar-com.yaml")
        cls.web = find(cls.site, "Deployment", "jithendar-com")
        cls.worker = find(load("35-jithendar-com-worker.yaml"), "Deployment", "jithendar-com-worker")
        cls.web_pod = cls.web["spec"]["template"]["spec"]
        cls.worker_pod = cls.worker["spec"]["template"]["spec"]
        cls.web_container = cls.web_pod["containers"][0]
        cls.worker_container = cls.worker_pod["containers"][0]

    def test_the_pod_is_the_web_pod(self) -> None:
        for key in ("initContainers", "volumes", "securityContext", "imagePullSecrets", "automountServiceAccountToken", "enableServiceLinks", "dnsPolicy", "terminationGracePeriodSeconds"):
            self.assertEqual(self.worker_pod.get(key), self.web_pod.get(key), f"pod spec field {key} differs between web and worker")
        for key in ("image", "imagePullPolicy", "envFrom", "securityContext", "volumeMounts", "startupProbe", "readinessProbe", "livenessProbe"):
            self.assertEqual(self.worker_container.get(key), self.web_container.get(key), f"container field {key} differs between web and worker")
        self.assertEqual(len(self.worker_pod["containers"]), 1)

    def test_the_environment_is_the_same_except_the_role(self) -> None:
        web = {e["name"]: e for e in self.web_container["env"]}
        worker = {e["name"]: e for e in self.worker_container["env"]}
        self.assertEqual(web["APP_ROLE"]["value"], "web")
        self.assertEqual(worker["APP_ROLE"]["value"], "worker")
        self.assertEqual(set(web) - set(worker), WEB_ONLY_ENV & set(web), "set on the web replicas only: add it to the worker, or to WEB_ONLY_ENV with the reason")
        self.assertEqual(set(worker) - set(web), set(), "set on the worker only")
        for name in set(web) & set(worker) - {"APP_ROLE"}:
            self.assertEqual(worker[name], web[name], f"{name} differs between web and worker")

    def test_it_is_one_pod_that_no_service_and_no_web_selector_picks_up(self) -> None:
        spec = self.worker["spec"]
        self.assertEqual((spec["replicas"], spec["strategy"]), (1, {"type": "Recreate"}))
        labels = spec["template"]["metadata"]["labels"]
        self.assertEqual(labels["app"], "jithendar-com-worker")
        self.assertEqual(spec["selector"]["matchLabels"], {"app": "jithendar-com-worker"})
        # The web Deployment, its Services and its PodDisruptionBudget select app=jithendar-com: never the worker.
        self.assertEqual(self.web["spec"]["selector"]["matchLabels"], {"app": "jithendar-com"})
        for doc in self.site:
            if doc["kind"] == "Service":
                self.assertEqual(doc["spec"]["selector"], {"app": "jithendar-com"}, doc["metadata"]["name"])
        self.assertNotIn("agent-callback", [p["name"] for p in self.worker_container["ports"]])

    def test_what_must_know_both_kinds_of_pod_does(self) -> None:
        # Egress (database, cache bus, seo-agent, executor, internet) is granted by these two policies.
        for name in ("jithendar-com", "jithendar-com-cache-bus"):
            self.assertTrue(selects_both(find(self.site, "NetworkPolicy", name)["spec"]["podSelector"]), name)
        # The services the background work calls let both in.
        executor = find(load("practice-executor-50-networkpolicies.yaml"), "NetworkPolicy", "practice-executor-api")
        self.assertTrue(any(selects_both(peer.get("podSelector", {})) for rule in executor["spec"]["ingress"] for peer in rule["from"]))
        agent = find(load("seo-agent-40-seo-agent.yaml"), "NetworkPolicy", "seo-agent")
        self.assertTrue(any(selects_both(peer.get("podSelector", {})) for rule in agent["spec"]["ingress"] for peer in rule["from"]))
        # Prometheus scrapes both through one headless Service, by a label both pod templates carry.
        metrics = find(load("70-observability.yaml"), "Service", "jithendar-com-metrics")["spec"]["selector"]
        for deployment in (self.web, self.worker):
            labels = deployment["spec"]["template"]["metadata"]["labels"]
            self.assertTrue(metrics.items() <= labels.items(), deployment["metadata"]["name"])
        # A release sets the image of both, so the CI deployer may patch both.
        role = find(load("80-ci-deployer.yaml"), "Role", "github-ci-deployer")
        patchable = next(r for r in role["rules"] if "patch" in r["verbs"])["resourceNames"]
        self.assertTrue(set(BOTH) <= set(patchable))
        self.assertIn("35-jithendar-com-worker.yaml", yaml.safe_load((MINIKUBE / "kustomization.yaml").read_text())["resources"])


if __name__ == "__main__":
    unittest.main()
