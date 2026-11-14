# Python practice code runner on mk4. Comments are on their own lines: pasted into zsh, a trailing "# ..." is
# passed to the command as arguments (unless `setopt interactivecomments`).

# 1. gVisor on every node. Must run ON THE mk4 HOST (where minikube runs), not on the Mac.
#    Dry run first (one "→ mk4..." block per node), then --apply (each node ends with "active" and a runsc version).
scp scripts/install-gvisor-mk4.sh <user>@<mk4-host>:/tmp/
ssh <user>@<mk4-host> bash /tmp/install-gvisor-mk4.sh
ssh <user>@<mk4-host> bash /tmp/install-gvisor-mk4.sh --apply

# 2. Back on the Mac. Every line must be PASS; stop here if not.
kubectl -n jithendar delete pod -l practice.jithendar.com/verify=true
scripts/verify-practice-sandbox.sh

# 3. Site: new executor URL + network rule + CI account rights, then restart (this was ./deploy.sh until
#    2026-11-14; the workflow applies minikube/ and restarts the site, and waits for the result)
gh workflow run deploy-minikube.yml --ref master
sleep 10 # give GitHub time to create the run before looking it up
gh run watch "$(gh run list --workflow deploy-minikube.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status

# 4. Pin the executor and sandbox images (needs the updated workflow pushed to master first)
gh workflow run ci-practice-executor.yml --ref master
