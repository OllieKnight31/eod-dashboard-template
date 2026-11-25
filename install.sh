#!/usr/bin/env bash
# Installs the EOD dashboard setup skill for Claude Code.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skill"
DEST="${HOME}/.claude/skills/eod-dashboard"
[ -f "${SRC}/SKILL.md" ] || { echo "skill/SKILL.md not found next to install.sh" >&2; exit 1; }
mkdir -p "${DEST}"
cp -R "${SRC}/." "${DEST}/"
echo "Installed the eod-dashboard skill to ${DEST}"
echo "In Claude Code, say: set up my EOD dashboard"
