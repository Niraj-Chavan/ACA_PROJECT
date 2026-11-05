#!/usr/bin/env bash
# upmem-env.example.sh — template for the UPMEM SDK environment.
#
# Copy this file to ../upmem-env.sh (one directory above the project root)
# and edit UPMEM_HOME to wherever the SDK is extracted:
#
#   cp upmem-env.example.sh ../upmem-env.sh
#   $EDITOR ../upmem-env.sh
#   source ../upmem-env.sh
#
# It MUST be sourced, not executed, so that PATH and LD_LIBRARY_PATH persist
# in the current shell. The `simulator` argument makes the SDK runtime use
# the functional DPU simulator instead of looking for a physical board.

UPMEM_HOME="${UPMEM_HOME:-$HOME/upmem-sdk/2025.1.0/ubuntu-20.04/upmem-2025.1.0-Linux-x86_64}"

if [ ! -f "$UPMEM_HOME/upmem_env.sh" ]; then
  echo "UPMEM SDK not found at: $UPMEM_HOME" >&2
  echo "Set UPMEM_HOME or edit this script before sourcing it." >&2
  return 1 2>/dev/null || exit 1
fi

# The SDK script resets LD_LIBRARY_PATH, so source it first, then append the
# compatibility directory used on distributions newer than Ubuntu 20.04.
source "$UPMEM_HOME/upmem_env.sh" simulator
export LD_LIBRARY_PATH="$UPMEM_HOME/lib:$HOME/.local/lib/upmem-fix:$LD_LIBRARY_PATH"

echo "UPMEM SDK ready: $UPMEM_HOME (simulator mode)"
