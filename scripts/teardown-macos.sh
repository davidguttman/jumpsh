#!/usr/bin/env bash
# teardown-macos.sh — Undo localhaus macOS setup
# Removes dnsmasq config, resolver file, mkcert root CA, and generated certs.
# Safe to run if items are already missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=setup-common.sh
source "${SCRIPT_DIR}/setup-common.sh"

# --- Pre-checks ---

check_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    print_error "This script is for macOS only. Use teardown-linux.sh on Linux."
    exit 1
  fi
}

# --- Teardown steps ---

remove_resolver() {
  print_header "Removing macOS resolver"

  local resolver_file="/etc/resolver/localhost"
  if [[ -f "${resolver_file}" ]]; then
    sudo rm -f "${resolver_file}"
    log "ACTION: removed ${resolver_file}"
    print_status "Removed ${resolver_file}"
  else
    print_status "Resolver file already absent"
  fi
}

remove_dnsmasq_config() {
  print_header "Removing dnsmasq config"

  if ! command -v brew &>/dev/null; then
    print_warn "Homebrew not found — skipping dnsmasq cleanup"
    return 0
  fi

  local brew_prefix
  brew_prefix="$(brew --prefix)"
  local dnsmasq_conf="${brew_prefix}/etc/dnsmasq.d/localhost.conf"

  if [[ -f "${dnsmasq_conf}" ]]; then
    rm -f "${dnsmasq_conf}"
    log "ACTION: removed ${dnsmasq_conf}"
    print_status "Removed ${dnsmasq_conf}"
  else
    print_status "dnsmasq config already absent"
  fi

  # Restart dnsmasq if it's running (to pick up config removal)
  if brew services list 2>/dev/null | grep -q "dnsmasq.*started"; then
    sudo brew services restart dnsmasq
    log "ACTION: restarted dnsmasq"
    print_status "Restarted dnsmasq"
  fi
}

uninstall_mkcert_ca() {
  print_header "Removing mkcert root CA"

  if command -v mkcert &>/dev/null; then
    mkcert -uninstall 2>&1 | while IFS= read -r line; do log "mkcert-uninstall: ${line}"; done
    log "ACTION: mkcert -uninstall"
    print_status "Uninstalled mkcert root CA from system trust store"
    print_warn "Restart your browser(s) for the CA removal to take effect."
  else
    print_status "mkcert not found — skipping CA removal"
  fi
}

remove_certs() {
  print_header "Removing generated certificates"

  if [[ -f "${CERT_FILE}" || -f "${KEY_FILE}" ]]; then
    rm -f "${CERT_FILE}" "${KEY_FILE}"
    log "ACTION: removed cert files from ${LOCALHAUS_CERTS_DIR}"
    print_status "Removed certificates from ${LOCALHAUS_CERTS_DIR}"
  else
    print_status "Certificate files already absent"
  fi

  # Remove certs dir if empty
  if [[ -d "${LOCALHAUS_CERTS_DIR}" ]] && [[ -z "$(ls -A "${LOCALHAUS_CERTS_DIR}" 2>/dev/null)" ]]; then
    rmdir "${LOCALHAUS_CERTS_DIR}"
    log "ACTION: removed empty ${LOCALHAUS_CERTS_DIR}"
  fi
}

# --- Main ---

main() {
  print_header "localhaus macOS teardown"

  check_macos
  setup_log

  log "Starting macOS teardown"

  remove_resolver
  remove_dnsmasq_config
  uninstall_mkcert_ca
  remove_certs

  print_header "Teardown complete"
  echo "  Log file: ${LOCALHAUS_LOG}"
  echo ""
  print_warn "Restart your browser(s) for certificate changes to take effect."
  echo ""

  log "macOS teardown complete"
}

main "$@"
