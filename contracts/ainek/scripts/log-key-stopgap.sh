#!/bin/zsh
# Stopgap until services/verifier exists: re-log the recorded KeyEntryInput for z-ai/glm-5.3-flash
# once a day so the client's 24 h window (`latest_keys`) never runs dry. Signs with the macOS
# keychain key of ainek-dev-dastan.testnet (a registered verifier). Remove the crontab line once
# the daemon is live. Not part of the product: the daemon derives the entry from a live attestation.
set -euo pipefail
export PATH="$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
REPO="${AINEK_REPO:-$HOME/Documents/ainek}"
CONTRACT="${AINEK_CONTRACT:-ainek-log-dastan.testnet}"
VERIFIER="${AINEK_VERIFIER:-ainek-dev-dastan.testnet}"

ENTRY=$(python3 -I - "$REPO/docs/test-vectors/canonical.json" <<'EOF'
import json, sys, time
d = json.load(open(sys.argv[1]))["commits"]["entry_hash"]["input"]
d["observed_at"] = str(int(time.time() * 1000))
print(json.dumps({"entry": d}))
EOF
)

near contract call-function as-transaction "$CONTRACT" log_key json-args "$ENTRY" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$VERIFIER" \
  network-config testnet sign-with-keychain send 2>&1 | grep -E 'Transaction ID|key_logged|rror|succeeded'
