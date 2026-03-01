#!/usr/bin/env bash
# setup-common.sh — Shared utilities for localhaus setup scripts
# Sourced by setup-macos.sh and setup-linux.sh

set -euo pipefail

LOCALHAUS_DIR="${HOME}/.localhaus"
LOCALHAUS_CERTS_DIR="${LOCALHAUS_DIR}/certs"
LOCALHAUS_LOG="${LOCALHAUS_DIR}/setup.log"

CERT_FILE="${LOCALHAUS_CERTS_DIR}/localhost.pem"
KEY_FILE="${LOCALHAUS_CERTS_DIR}/localhost-key.pem"

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
  mkdir -p "${LOCALHAUS_DIR}"
  echo "--- localhaus setup $(date -u '+%Y-%m-%dT%H:%M:%SZ') ---" >> "${LOCALHAUS_LOG}"
}

log() {
  echo "[$(date -u '+%H:%M:%S')] $*" >> "${LOCALHAUS_LOG}"
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
    print_status "Certs already exist at ${LOCALHAUS_CERTS_DIR}"
    log "SKIP: certs already exist"
    return 0
  fi

  if ! check_command mkcert "mkcert is required for certificate generation."; then
    return 1
  fi

  mkdir -p "${LOCALHAUS_CERTS_DIR}"
  log "ACTION: generating certs in ${LOCALHAUS_CERTS_DIR}"

  mkcert -install 2>&1 | while IFS= read -r line; do log "mkcert-install: ${line}"; done

  mkcert \
    -cert-file "${CERT_FILE}" \
    -key-file "${KEY_FILE}" \
    "*.localhost" localhost 127.0.0.1 ::1 \
    2>&1 | while IFS= read -r line; do log "mkcert: ${line}"; done

  if [[ -f "${CERT_FILE}" && -f "${KEY_FILE}" ]]; then
    print_status "Certs generated:"
    echo "       cert: ${CERT_FILE}"
    echo "       key:  ${KEY_FILE}"
  else
    print_error "Certificate generation failed. Check ${LOCALHAUS_LOG}"
    return 1
  fi
}

# --- DNS verification ---

verify_dns() {
  print_header "Verifying DNS resolution"

  local test_host="test.localhost"

  # Try dig first
  if command -v dig &>/dev/null; then
    local result
    result=$(dig +short "${test_host}" @127.0.0.1 2>/dev/null || true)
    if [[ "${result}" == "127.0.0.1" ]]; then
      print_status "${test_host} resolves to 127.0.0.1 via dnsmasq"
      return 0
    fi
  fi

  # Fallback: try getent or ping
  if command -v getent &>/dev/null; then
    local result
    result=$(getent hosts "${test_host}" 2>/dev/null | awk '{print $1}' || true)
    if [[ "${result}" == "127.0.0.1" ]]; then
      print_status "${test_host} resolves to 127.0.0.1 via system resolver"
      return 0
    fi
  fi

  print_warn "Could not verify DNS for ${test_host}."
  print_warn "This may be normal — browsers resolve *.localhost natively (RFC 6761)."
  print_warn "System tools (curl, wget) may need dnsmasq running."
  return 0
}

# --- Finish ---

print_finish() {
  print_header "Setup complete"
  echo "  Cert dir:  ${LOCALHAUS_CERTS_DIR}"
  echo "  Log file:  ${LOCALHAUS_LOG}"
  echo ""
  print_warn "Restart your browser(s) for the mkcert root CA to take effect."
  echo ""
}
