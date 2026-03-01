#!/usr/bin/env bash
# teardown-linux.sh — Undo localhaus Linux setup
# Removes dnsmasq config, systemd-resolved drop-in, mkcert root CA, generated certs,
# and WSL2 /etc/hosts entries. Safe to run if items are already missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=setup-common.sh
source "${SCRIPT_DIR}/setup-common.sh"

# --- Pre-checks ---

check_linux() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    print_error "This script is for Linux only. Use teardown-macos.sh on macOS."
    exit 1
  fi
}

is_wsl2() {
  if grep -qi microsoft /proc/version 2>/dev/null; then
    return 0
  fi
  if [[ -d /mnt/c/Windows ]]; then
    return 0
  fi
  return 1
}

# --- Teardown steps ---

remove_dnsmasq_config() {
  print_header "Removing dnsmasq config"

  local dnsmasq_conf="/etc/dnsmasq.d/localhost.conf"
  local dnsmasq_port_conf="/etc/dnsmasq.d/localhaus-port.conf"

  if [[ -f "${dnsmasq_conf}" ]]; then
    sudo rm -f "${dnsmasq_conf}"
    log "ACTION: removed ${dnsmasq_conf}"
    print_status "Removed ${dnsmasq_conf}"
  else
    print_status "dnsmasq config already absent"
  fi

  if [[ -f "${dnsmasq_port_conf}" ]]; then
    sudo rm -f "${dnsmasq_port_conf}"
    log "ACTION: removed ${dnsmasq_port_conf}"
    print_status "Removed ${dnsmasq_port_conf}"
  else
    print_status "dnsmasq port config already absent"
  fi

  # Restart dnsmasq if it's running
  if systemctl is-active --quiet dnsmasq 2>/dev/null; then
    sudo systemctl restart dnsmasq
    log "ACTION: restarted dnsmasq"
    print_status "Restarted dnsmasq"
  fi
}

remove_resolved_config() {
  print_header "Removing systemd-resolved config"

  local resolved_conf="/etc/systemd/resolved.conf.d/localhaus.conf"

  if [[ -f "${resolved_conf}" ]]; then
    sudo rm -f "${resolved_conf}"
    log "ACTION: removed ${resolved_conf}"
    print_status "Removed ${resolved_conf}"

    # Remove drop-in dir if empty
    local resolved_dir="/etc/systemd/resolved.conf.d"
    if [[ -d "${resolved_dir}" ]] && [[ -z "$(ls -A "${resolved_dir}" 2>/dev/null)" ]]; then
      sudo rmdir "${resolved_dir}"
      log "ACTION: removed empty ${resolved_dir}"
    fi

    # Restart resolved if it's running
    if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
      sudo systemctl restart systemd-resolved
      log "ACTION: restarted systemd-resolved"
      print_status "Restarted systemd-resolved"
    fi
  else
    print_status "systemd-resolved config already absent"
  fi
}

remove_wsl2_hosts() {
  print_header "Removing WSL2 /etc/hosts entries"

  if grep -q '# localhaus-managed' /etc/hosts 2>/dev/null; then
    # Remove only lines tagged with the localhaus marker comment
    local tmpfile
    tmpfile=$(mktemp)
    grep -v '# localhaus-managed' /etc/hosts > "${tmpfile}" || true
    sudo cp "${tmpfile}" /etc/hosts
    rm -f "${tmpfile}"
    log "ACTION: removed localhaus-managed entries from /etc/hosts"
    print_status "Removed localhaus-managed entries from /etc/hosts"
  else
    print_status "No localhaus-managed entries in /etc/hosts"
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
  print_header "localhaus Linux teardown"

  check_linux
  setup_log

  log "Starting Linux teardown"

  if is_wsl2; then
    remove_wsl2_hosts
  else
    remove_dnsmasq_config
    remove_resolved_config
  fi

  uninstall_mkcert_ca
  remove_certs

  print_header "Teardown complete"
  echo "  Log file: ${LOCALHAUS_LOG}"
  echo ""
  print_warn "Restart your browser(s) for certificate changes to take effect."
  echo ""

  log "Linux teardown complete"
}

main "$@"
