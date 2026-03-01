#!/usr/bin/env bash
# enable-low-port-bind-linux.sh — Grant Node.js capability to bind ports < 1024
# Required for LOCALHAUS_PORT=443 (no-port HTTPS UX) on Linux.
# Uses setcap(8) — requires sudo.
#
# Handles version managers (mise, nvm, fnm, volta) where `which node` may
# resolve to a launcher/shim rather than the actual Node ELF binary.

set -euo pipefail

# --- Detect the real Node binary ---

MISE_NODE_DIR="${HOME}/.local/share/mise/installs/node"

is_node_elf() {
  local bin="$1"
  [[ -x "${bin}" ]] && file -b "${bin}" 2>/dev/null | grep -qi 'ELF'
}

find_node_binary() {
  # Step 1: Try `which node` and readlink -f
  local which_node
  which_node="$(which node 2>/dev/null || true)"
  if [[ -n "${which_node}" ]]; then
    local resolved
    resolved="$(readlink -f "${which_node}" 2>/dev/null || echo "${which_node}")"

    # Check if readlink resolved to an actual node ELF (not a launcher like mise)
    if is_node_elf "${resolved}" && [[ "$(basename "${resolved}")" == "node" ]]; then
      echo "${resolved}"
      return 0
    fi
  fi

  # Step 2: Try mise installs directory (find latest version)
  if [[ -d "${MISE_NODE_DIR}" ]]; then
    local latest_node
    # Sort versions numerically, pick the highest
    latest_node=$(ls -1 "${MISE_NODE_DIR}" 2>/dev/null | sort -V | tail -1)
    if [[ -n "${latest_node}" ]]; then
      local candidate="${MISE_NODE_DIR}/${latest_node}/bin/node"
      if is_node_elf "${candidate}"; then
        echo "${candidate}"
        return 0
      fi
    fi
  fi

  # Step 3: Try mise shims directory (if it's an ELF, not a script)
  local mise_shim="${HOME}/.local/share/mise/shims/node"
  if [[ -x "${mise_shim}" ]]; then
    local resolved
    resolved="$(readlink -f "${mise_shim}" 2>/dev/null || echo "${mise_shim}")"
    if is_node_elf "${resolved}" && [[ "$(basename "${resolved}")" == "node" ]]; then
      echo "${resolved}"
      return 0
    fi
  fi

  # Step 4: Try common version manager install paths
  for candidate_dir in \
    "${HOME}/.nvm/versions/node" \
    "${HOME}/.local/share/fnm/node-versions" \
    "${HOME}/.volta/tools/image/node"; do
    if [[ -d "${candidate_dir}" ]]; then
      local latest
      latest=$(ls -1 "${candidate_dir}" 2>/dev/null | sort -V | tail -1)
      if [[ -n "${latest}" ]]; then
        local candidate="${candidate_dir}/${latest}/bin/node"
        if is_node_elf "${candidate}"; then
          echo "${candidate}"
          return 0
        fi
      fi
    fi
  done

  return 1
}

# --- Main ---

NODE_REAL="$(find_node_binary || true)"

if [[ -z "${NODE_REAL}" ]]; then
  echo "Error: Could not find the real Node.js ELF binary." >&2
  echo "" >&2
  echo "Looked in:" >&2
  echo "  - \$(which node) → $(which node 2>/dev/null || echo 'not found')" >&2
  echo "  - ${MISE_NODE_DIR}/<version>/bin/node" >&2
  echo "  - ${HOME}/.local/share/mise/shims/node" >&2
  echo "  - nvm/fnm/volta install directories" >&2
  echo "" >&2
  echo "To fix manually:" >&2
  echo "  1. Find your real node binary: file \$(node -e 'console.log(process.execPath)')" >&2
  echo "  2. Run: sudo setcap cap_net_bind_service=+ep /path/to/actual/node" >&2
  exit 1
fi

echo "Detected Node binary: ${NODE_REAL}"
echo "  file type: $(file -b "${NODE_REAL}" | head -c 80)"
echo ""

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "[dry-run] Would run: sudo setcap cap_net_bind_service=+ep ${NODE_REAL}"
  echo "[dry-run] Current capabilities:"
  getcap "${NODE_REAL}" 2>/dev/null || echo "  (none)"
  exit 0
fi

echo "Granting cap_net_bind_service to: ${NODE_REAL}"
sudo setcap cap_net_bind_service=+ep "${NODE_REAL}"

echo ""
echo "Verifying capabilities:"
getcap "${NODE_REAL}"

echo ""
echo "Done. Node can now bind to ports < 1024 (e.g., 443)."
echo "Set LOCALHAUS_PORT=443 in .env for no-port HTTPS."
