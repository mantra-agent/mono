#!/bin/sh
# Unshallow the git repo if Railway cloned with --depth 1.
# This runs at container start so .git is already present from the
# build context — no need to COPY it between Docker stages.
git fetch --unshallow 2>/dev/null || true
exec node dist/index.mjs
