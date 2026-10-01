#!/usr/bin/env bash
# Run in Codex Cloud's setup AND maintenance phases, where downloads are allowed.
set -euo pipefail
# Cloud executes setup at the repository root. This also permits pasting this
# bootstrap into environment settings before the script is merged to master.
cd "$(git rev-parse --show-toplevel)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  echo "VALIDATION_NVM_MISSING: select the Codex universal image with nvm available." >&2
  exit 1
fi
# .nvmrc names a version that may not exist yet on a cold container. Avoid
# nvm's automatic `use` failure before the explicit install below.
source "$NVM_DIR/nvm.sh" --no-use
node_version="$(tr -d '[:space:]' < .nvmrc)"
nvm install "$node_version"
nvm alias default "$node_version"
nvm use "$node_version"
npm_version="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).engines.npm')"
if [[ "$(npm --version)" != "$npm_version" ]]; then
  npm install --global "npm@$npm_version" --no-audit --no-fund
fi
# Setup exports do not survive into the agent shell. Activate the pin in new
# interactive and login Bash shells, including cached-container follow-ups.
activation="export NVM_DIR=\"$NVM_DIR\"; [ ! -s \"\$NVM_DIR/nvm.sh\" ] || { source \"\$NVM_DIR/nvm.sh\" --no-use; nvm use --silent $node_version; }"
login_profile="$HOME/.profile"
if [[ -f "$HOME/.bash_profile" ]]; then login_profile="$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then login_profile="$HOME/.bash_login"
fi
for profile in "$HOME/.bashrc" "$login_profile"; do
  touch "$profile"
  if ! grep -Fqx "$activation" "$profile"; then printf '\n%s\n' "$activation" >> "$profile"; fi
done
if [[ -f scripts/setup-validation.mjs ]]; then
  npm run setup:validation
  npm run validation:ready
else
  # Older PR branches do not yet contain the guarded setup entrypoint.
  npm ci --include=dev --include=optional --ignore-scripts=false --no-audit --no-fund
  node node_modules/typescript/bin/tsc --version
  node node_modules/vitest/vitest.mjs --version
fi
# Prove setup's exports are unnecessary in the next login shell. A persistence
# failure stops setup rather than letting the agent start on the image default.
env -u NVM_DIR -u NVM_BIN -u NVM_INC PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin bash -lc '
  set -euo pipefail
  cd "$1"
  expected_node="v$(tr -d "[:space:]" < .nvmrc)"
  expected_npm="$(node -p '\''JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).engines.npm'\'')"
  if [[ "$(node --version)" != "$expected_node" || "$(npm --version)" != "$expected_npm" ]]; then
    echo "VALIDATION_LOGIN_RUNTIME_MISMATCH: pinned runtime did not persist into a new shell" >&2
    exit 1
  fi
  if [[ -f scripts/validation-environment.mjs ]]; then npm run validation:ready
  else node node_modules/typescript/bin/tsc --version; node node_modules/vitest/vitest.mjs --version
  fi
' validation-login "$PWD"
