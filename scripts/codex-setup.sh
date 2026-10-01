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
source "$NVM_DIR/nvm.sh"
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
activation="export NVM_DIR=\"$NVM_DIR\"; [ ! -s \"\$NVM_DIR/nvm.sh\" ] || { source \"\$NVM_DIR/nvm.sh\"; nvm use --silent $node_version; }"
for profile in "$HOME/.bashrc" "$HOME/.bash_profile"; do
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
