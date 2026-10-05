#!/usr/bin/env bash
set -euo pipefail

echo "==> Checking tools and environment..."
node -v
pnpm -v
python3 --version

echo "==> Running contracts tests and build..."
pnpm --filter @open-design/contracts test
pnpm --filter @open-design/contracts build

echo "==> Running daemon typecheck and deployment lifecycle tests..."
pnpm --filter @open-design/daemon test tests/deployment-lifecycle.test.ts
pnpm --filter @open-design/daemon test tests/project-file-versions.test.ts
pnpm --filter @open-design/daemon build

echo "==> Running web typecheck..."
pnpm --filter @open-design/web typecheck

if [ -f "tests/handoff/test_import_handoff.py" ]; then
  echo "==> Running handoff importer tests..."
  python3 -m unittest discover -s tests/handoff -p 'test_*.py' -v
fi

echo "==> All verification gates passed cleanly."
