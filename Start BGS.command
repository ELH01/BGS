#!/bin/bash
# Double-click this file to start the platform (macOS / Linux).
#
# Runs from wherever the project folder lives, so the folder can be moved or
# renamed without breaking the launcher.
cd "$(dirname "$0")" || exit 1
exec node scripts/launch.mjs
