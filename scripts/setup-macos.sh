#!/usr/bin/env bash
# setup-macos.sh — macOS setup for localhaus (dnsmasq + mkcert)
# Installs wildcard DNS for *.localhaus and generates TLS certificates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=setup-common.sh
source "${SCRIPT_DIR}/setup-common.sh"

# --- Pre-checks ---

check_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    print_error "This script is for macOS only. Use setup-linux.sh on Linux."
    exit 1
  fi
}

check_homebrew() {
  if ! check_command brew "Homebrew is required. Install from https://brew.sh"; then
    exit 1
  fi
}

# --- dnsmasq ---

install_dnsmasq() {
  print_header "Setting up dnsmasq"

  if brew list dnsmasq &>/dev/null; then
    print_status "dnsmasq already installed"
  else
    log "ACTION: brew install dnsmasq"
    brew install dnsmasq
    print_status "dnsmasq installed"
  fi

  local brew_prefix
  brew_prefix="$(brew --prefix)"
  local dnsmasq_conf_dir="${brew_prefix}/etc/dnsmasq.d"
  local dnsmasq_conf="${dnsmasq_conf_dir}/localhost.conf"
  local dnsmasq_main="${brew_prefix}/etc/dnsmasq.conf"
  local target_line="address=/.localhaus/127.0.0.1"

  # Ensure dnsmasq.d include exists in main config
  mkdir -p "${dnsmasq_conf_dir}"
  local include_line="conf-dir=${dnsmasq_conf_dir}/,*.conf"
  if ! grep -qF "${include_line}" "${dnsmasq_main}" 2>/dev/null; then
    echo "${include_line}" >> "${dnsmasq_main}"
    log "ACTION: added conf-dir include to ${dnsmasq_main}"
    print_status "Added conf-dir include to dnsmasq.conf"
  fi

  # Write localhost.conf
  if [[ -f "${dnsmasq_conf}" ]] && grep -qF "${target_line}" "${dnsmasq_conf}"; then
    print_status "dnsmasq already configured for *.localhaus"
  else
    echo "${target_line}" > "${dnsmasq_conf}"
    log "ACTION: wrote ${dnsmasq_conf}"
    print_status "Configured dnsmasq for *.localhaus"
  fi

  # Restart dnsmasq
  log "ACTION: restarting dnsmasq"
  sudo brew services restart dnsmasq
  print_status "dnsmasq restarted"
}

# --- Resolver ---

setup_resolver() {
  print_header "Setting up macOS resolver"

  local resolver_file="/etc/resolver/localhaus"

  if [[ -f "${resolver_file}" ]] && grep -qF "nameserver 127.0.0.1" "${resolver_file}"; then
    print_status "Resolver already configured at ${resolver_file}"
    return 0
  fi

  log "ACTION: creating ${resolver_file}"
  sudo mkdir -p /etc/resolver
  echo "nameserver 127.0.0.1" | sudo tee "${resolver_file}" > /dev/null
  print_status "Created ${resolver_file}"
}

# --- mkcert ---

install_mkcert() {
  print_header "Setting up mkcert"

  if brew list mkcert &>/dev/null; then
    print_status "mkcert already installed"
  else
    log "ACTION: brew install mkcert"
    brew install mkcert
    print_status "mkcert installed"
  fi
}

# --- Main ---

main() {
  print_header "localhaus macOS setup"

  check_macos
  check_homebrew
  setup_log

  log "Starting macOS setup"

  install_dnsmasq
  setup_resolver
  install_mkcert
  generate_certs
  verify_dns
  print_finish

  echo ""
  echo "  Target UX: https://localhaus.localhaus (no port)"
  echo "               https://<project>.localhaus"
  echo "  Set LOCALHAUS_PORT=443 and LOCALHAUS_HTTPS=true in .env"
  echo ""

  log "macOS setup complete"
}

main "$@"
