#!/usr/bin/env bash
# setup-common.sh — Shared utilities for jump.sh setup
# Used by jumpsh install command

set -euo pipefail

JUMPSH_DIR="${HOME}/.jump.sh"
JUMPSH_CERTS_DIR="${JUMPSH_DIR}/certs"
JUMPSH_LOG="${JUMPSH_DIR}/setup.log"

CERT_FILE="${JUMPSH_CERTS_DIR}/server.pem"
KEY_FILE="${JUMPSH_CERTS_DIR}/server-key.pem"

# Colors (only when stdout is a terminal)
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN=''
  YELLOW=''
  RED=''
  BOLD=''
  NC=''
fi

# --- Logging ---

setup_log() {
  mkdir -p "${JUMPSH_DIR}"
  echo "--- jump.sh setup $(date -u '+%Y-%m-%dT%H:%M:%SZ') ---" >> "${JUMPSH_LOG}"
}

log() {
  echo "[$(date -u '+%H:%M:%S')] $*" >> "${JUMPSH_LOG}"
}

# --- Output helpers ---

print_status() {
  echo -e "${GREEN}✓${NC} $*"
  log "OK: $*"
}

print_warn() {
  echo -e "${YELLOW}!${NC} $*"
  log "WARN: $*"
}

print_error() {
  echo -e "${RED}✗${NC} $*" >&2
  log "ERROR: $*"
}

print_header() {
  echo ""
  echo -e "${BOLD}$*${NC}"
  echo ""
}

# --- Checks ---

check_command() {
  local cmd="$1"
  local msg="${2:-"${cmd} is required but not found."}"
  if ! command -v "${cmd}" &>/dev/null; then
    print_error "${msg}"
    return 1
  fi
  return 0
}

# --- Certificate generation ---

generate_certs() {
  print_header "Generating TLS certificates"

  if [[ -f "${CERT_FILE}" && -f "${KEY_FILE}" ]]; then
    print_status "Certs already exist at ${JUMPSH_CERTS_DIR}"
    log "SKIP: certs already exist"
    return 0
  fi

  if ! check_command mkcert "mkcert is required for certificate generation."; then
    return 1
  fi

  mkdir -p "${JUMPSH_CERTS_DIR}"
  log "ACTION: generating certs in ${JUMPSH_CERTS_DIR}"

  mkcert -install 2>&1 | while IFS= read -r line; do log "mkcert-install: ${line}"; done

  mkcert \
    -cert-file "${CERT_FILE}" \
    -key-file "${KEY_FILE}" \
    "*.jump.sh" jump.sh localhost 127.0.0.1 ::1 \
    2>&1 | while IFS= read -r line; do log "mkcert: ${line}"; done

  if [[ -f "${CERT_FILE}" && -f "${KEY_FILE}" ]]; then
    print_status "Certs generated:"
    echo "       cert: ${CERT_FILE}"
    echo "       key:  ${KEY_FILE}"
  else
    print_error "Certificate generation failed. Check ${JUMPSH_LOG}"
    return 1
  fi
}

# --- Finish ---

print_finish() {
  print_header "Setup complete"
  echo "  Cert dir:  ${JUMPSH_CERTS_DIR}"
  echo "  Log file:  ${JUMPSH_LOG}"
  echo ""
  print_warn "Restart your browser(s) for the mkcert root CA to take effect."
  echo ""
}
