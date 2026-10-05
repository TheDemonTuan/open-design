#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 && "$1" =~ ^ghcr\.io/thedemontuan/opendesign@sha256:[0-9a-f]{64}$ ]] || {
  echo "Expected immutable opendesign image digest, got: ${1:-empty}" >&2
  exit 2
}
image_ref="$1"
echo "==> Pulling freshly built image for runtime smoke test: $image_ref"
docker pull "$image_ref"

smoke_data_dir="$(mktemp -d /tmp/od-smoke-data-XXXXXX)"
chmod 777 "$smoke_data_dir"
smoke_token="smoke-token-$(head -c 16 /dev/urandom | xxd -p)"

echo "==> Starting container with production-grade flags and limits..."
cid="$(docker run -d \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 256 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "${smoke_data_dir}:/app/.od:rw" \
  -e OD_DATA_DIR=/app/.od \
  -e OD_BIND_HOST=0.0.0.0 \
  -e OD_PORT=7456 \
  -e OD_WEB_PORT=7456 \
  -e OD_DEPLOYMENT_SLOT=single \
  -e OD_API_TOKEN="$smoke_token" \
  -e OD_ALLOWED_ORIGINS="https://design.tuannguyenviet.site" \
  "$image_ref")"

echo "Container ID: $cid"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true; rm -rf "$smoke_data_dir" || true' EXIT

echo "==> Waiting for container to be ready (max 45s)..."
ready=false
for i in $(seq 1 45); do
  status="$(docker exec "$cid" node -e '
    fetch("http://127.0.0.1:7456/api/ready")
      .then(r => process.exit(r.status === 200 ? 0 : 1))
      .catch(() => process.exit(1));
  ' 2>/dev/null && echo "ok" || echo "wait")"
  if [ "$status" = "ok" ]; then
    ready=true
    break
  fi
  sleep 1
done

if [ "$ready" != "true" ]; then
  echo "Container failed to become ready in 45s. Container logs:" >&2
  docker logs "$cid" >&2
  exit 1
fi

echo "==> 1. Verifying /api/health and /api/ready endpoints..."
docker exec "$cid" node -e '
const assert = require("node:assert/strict");
async function check() {
  const healthRes = await fetch("http://127.0.0.1:7456/api/health");
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get("cache-control"), "no-store");
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.deployment_slot, "single");

  const readyRes = await fetch("http://127.0.0.1:7456/api/ready");
  assert.equal(readyRes.status, 200);
  const ready = await readyRes.json();
  assert.equal(ready.ok, true);
  assert.equal(ready.ready, true);
}
check().catch(e => { console.error(e); process.exit(1); });
'

echo "==> 2. Verifying absence of coding CLI binaries..."
docker exec "$cid" sh -c '
for cmd in opencode claude aider cursor codex; do
  if which "$cmd" >/dev/null 2>&1; then
    echo "ERROR: CLI binary $cmd found in image" >&2
    exit 1
  fi
done
echo "No coding CLIs found (verified clean)."
'

echo "==> 3. Verifying loopback deployment fence and status API..."
docker exec "$cid" node -e '
const assert = require("node:assert/strict");
async function check() {
  const statusRes = await fetch("http://127.0.0.1:7456/api/deployment/status");
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json();
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.phase, "open");
  assert.equal(status.accepting, true);
  assert.equal(status.idle, true);

  const fenceRes = await fetch("http://127.0.0.1:7456/api/deployment/fence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "smoke-op-1" }),
  });
  assert.equal(fenceRes.status, 200);
  const fenced = await fenceRes.json();
  assert.equal(fenced.phase, "draining");
  assert.equal(fenced.accepting, false);

  const readyFencedRes = await fetch("http://127.0.0.1:7456/api/ready");
  assert.equal(readyFencedRes.status, 503);

  const quiesceRes = await fetch("http://127.0.0.1:7456/api/deployment/quiesce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "smoke-op-1" }),
  });
  assert.equal(quiesceRes.status, 200);
  const quiesced = await quiesceRes.json();
  assert.equal(quiesced.phase, "quiesced");

  const resumeRes = await fetch("http://127.0.0.1:7456/api/deployment/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "smoke-op-1" }),
  });
  assert.equal(resumeRes.status, 200);
  const resumed = await resumeRes.json();
  assert.equal(resumed.phase, "open");
  assert.equal(resumed.accepting, true);
}
check().catch(e => { console.error(e); process.exit(1); });
'

echo "==> 4. Verifying foreign Origin header rejected on internal deployment endpoints..."
docker exec "$cid" node -e '
const assert = require("node:assert/strict");
async function check() {
  const foreignRes = await fetch("http://127.0.0.1:7456/api/deployment/status", {
    headers: { Origin: "https://evil.attacker.com" },
  });
  assert.equal(foreignRes.status, 403);
}
check().catch(e => { console.error(e); process.exit(1); });
'

echo "==> All runtime image smoke tests passed cleanly."
