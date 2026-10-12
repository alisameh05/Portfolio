#!/bin/bash
set -euo pipefail

case "${1:-phase6}" in
  phase6|checks) ;;
  *) echo 'Choose phase6 (real Media/CV acceptance) or checks (local checks).' >&2; exit 2 ;;
esac

daemon_pid=''
reset_private_services() {
  local containers
  # These commands address only this container's private Unix-socket daemon.
  # Keep downloaded images; discard disposable services left by interrupted runs.
  containers=$(docker ps --all --quiet) || return 1
  if [ -n "$containers" ]; then docker rm --force $containers >/dev/null || return 1; fi
  docker volume prune --all --force >/dev/null || return 1
  docker network prune --force >/dev/null
}
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [ "${mode}" = phase6 ]; then
    for report in phase6-media-integration.json phase6-cv-portfolio-154.json; do
      if [ -f "/workspace/evidence/$report" ]; then
        cp "/workspace/evidence/$report" "/evidence/$report" || result=1
      fi
    done
  fi
  if [ -n "$daemon_pid" ]; then
    reset_private_services || result=1
    kill -TERM "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" || true
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mode="${1:-phase6}"

# Copy source into Linux storage. Never mix Linux dependencies into the host tree.
tar -C /source --exclude='./.git' --exclude='./node_modules' --exclude='./.worktrees' \
  --exclude='./.next' --exclude='./artifacts' --exclude='./coverage' --exclude='./dist' \
  --exclude='./.env' --exclude='./.env.*' -cf - . | tar -C /workspace -xf -
# Preserve the repository's example so the source fingerprint matches a clone.
if [ -f /source/.env.example ]; then cp /source/.env.example /workspace/.env.example; fi
# Only fresh reports from this invocation can be exported, including on failure.
if [ "$mode" = phase6 ]; then
  rm -f /workspace/evidence/phase6-media-integration.json /workspace/evidence/phase6-cv-portfolio-154.json
  rm -f /evidence/phase6-media-integration.json /evidence/phase6-cv-portfolio-154.json
fi
# Build a private Git view without host paths, hooks, config or credentials.
# This also avoids Windows worktree-specific config changing Linux ref lookup.
mkdir /workspace/.git
cp /git/worktree/HEAD /git/worktree/index /workspace/.git/
ln -s /git/common/objects /workspace/.git/objects
ln -s /git/common/refs /workspace/.git/refs
for metadata in packed-refs shallow; do
  if [ -f "/git/common/$metadata" ]; then cp "/git/common/$metadata" /workspace/.git/; fi
done
unset GIT_COMMON_DIR GIT_DIR GIT_WORK_TREE
git rev-parse --verify HEAD >/dev/null

# Use the pinned official DinD bootstrap to enable nested cgroup controllers.
# Starting dockerd directly can start services but reject resource-limited tools.
dind dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 \
  --data-root=/var/lib/docker > /tmp/portfolio-dockerd.log 2>&1 &
daemon_pid=$!
for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    echo 'Private Docker engine failed to start; inspect the validation container.' >&2
    exit 1
  fi
  sleep 1
done
docker info >/dev/null
reset_private_services
npm run setup:validation
npm run validation:ready

if [ "${1:-phase6}" = checks ]; then
  # The hard-file-limit test must use the actual pinned processor image.
  docker pull "$(node --input-type=module -e 'import {PHASE6_TOOL_DEFINITIONS as tools} from "./scripts/phase6-verification-support.mjs"; console.log(tools.pdfProcessor)')"
  npm run test:setup
  npm run test:phase6:verification
  npm run typecheck
  npm run test:arch
  npm run lint
  ./node_modules/.bin/vitest run tests/runtime/media-processing-tools.test.ts tests/modules/media-processing.test.ts tests/modules/cv-portfolio.test.ts
else
  npm run phase6:focus:media-integration
  npm run phase6:focus:cv-portfolio
fi
