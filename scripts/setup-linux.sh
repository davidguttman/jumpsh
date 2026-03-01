#!/usr/bin/env bash
# setup-linux.sh — Linux setup for localhaus (dnsmasq + mkcert)
# Installs wildcard DNS for *.localhaus and generates TLS certificates.
# Includes WSL2 detection: skips dnsmasq under WSL2 and provides /etc/hosts guidance.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=setup-common.sh
source "${SCRIPT_DIR}/setup-common.sh"

# --- Pre-checks ---

check_linux() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    print_error "This script is for Linux only. Use setup-macos.sh on macOS."
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

# --- Package manager detection ---

detect_pkg_manager() {
  if command -v apt-get &>/dev/null; then
    echo "apt"
  elif command -v dnf &>/dev/null; then
    echo "dnf"
  elif command -v pacman &>/dev/null; then
    echo "pacman"
  else
    echo ""
  fi
}

pkg_install() {
  local pkg="$1"
  local pm
  pm=$(detect_pkg_manager)

  case "${pm}" in
    apt)
      log "ACTION: sudo apt-get install -y ${pkg}"
      sudo apt-get update -qq
      sudo apt-get install -y "${pkg}"
      ;;
    dnf)
      log "ACTION: sudo dnf install -y ${pkg}"
      sudo dnf install -y "${pkg}"
      ;;
    pacman)
      log "ACTION: sudo pacman -S --noconfirm ${pkg}"
      sudo pacman -S --noconfirm "${pkg}"
      ;;
    *)
      print_error "No supported package manager found (need apt, dnf, or pacman)."
      exit 1
      ;;
  esac
}

# --- dnsmasq ---

install_dnsmasq() {
  print_header "Setting up dnsmasq"

  if command -v dnsmasq &>/dev/null; then
    print_status "dnsmasq already installed"
  else
    pkg_install dnsmasq
    print_status "dnsmasq installed"
  fi

  local dnsmasq_main="/etc/dnsmasq.conf"
  local dnsmasq_conf_dir="/etc/dnsmasq.d"
  local dnsmasq_conf="${dnsmasq_conf_dir}/localhost.conf"

  sudo mkdir -p "${dnsmasq_conf_dir}"

  # Ensure /etc/dnsmasq.conf includes the conf-dir directive
  local include_line="conf-dir=${dnsmasq_conf_dir}/,*.conf"
  if [[ -f "${dnsmasq_main}" ]]; then
    # Check for active (non-commented) conf-dir line
    if grep -qE "^conf-dir=${dnsmasq_conf_dir}" "${dnsmasq_main}" 2>/dev/null; then
      print_status "dnsmasq.conf already includes ${dnsmasq_conf_dir}"
    else
      echo "${include_line}" | sudo tee -a "${dnsmasq_main}" > /dev/null
      log "ACTION: appended conf-dir include to ${dnsmasq_main}"
      print_status "Added conf-dir include to ${dnsmasq_main}"
    fi
  else
    echo "${include_line}" | sudo tee "${dnsmasq_main}" > /dev/null
    log "ACTION: created ${dnsmasq_main} with conf-dir include"
    print_status "Created ${dnsmasq_main} with conf-dir include"
  fi

  # Write consolidated localhost.conf: always bind on 5353 to avoid port 53 conflicts
  # with systemd-resolved. This is safe even without systemd-resolved.
  sudo tee "${dnsmasq_conf}" > /dev/null <<'EOF'
# localhaus: wildcard DNS for *.localhaus
# Listens on port 5353 to avoid conflict with systemd-resolved on port 53
port=5353
listen-address=127.0.0.1
bind-interfaces
address=/.localhaus/127.0.0.1
EOF
  log "ACTION: wrote ${dnsmasq_conf} (port 5353, bind-interfaces)"
  print_status "Configured dnsmasq for *.localhaus on port 5353"
}

# --- systemd-resolved integration ---

configure_resolved() {
  print_header "Configuring systemd-resolved"

  # Always write the resolved drop-in, even if resolved isn't currently active.
  # This makes the setup idempotent and correct if resolved gets enabled later.
  local resolved_drop_dir="/etc/systemd/resolved.conf.d"
  local resolved_conf="${resolved_drop_dir}/localhaus.conf"

  sudo mkdir -p "${resolved_drop_dir}"
  sudo tee "${resolved_conf}" > /dev/null <<'EOF'
# Added by localhaus setup — forwards .localhaus queries to dnsmasq on port 5353
[Resolve]
DNS=127.0.0.1:5353
Domains=~localhaus
EOF
  log "ACTION: wrote ${resolved_conf} (DNS=127.0.0.1:5353)"
  print_status "Created/updated systemd-resolved drop-in for .localhaus"

  # Restart resolved if active
  if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
    log "ACTION: restarting systemd-resolved"
    sudo systemctl restart systemd-resolved
    print_status "systemd-resolved restarted"
  else
    print_status "systemd-resolved not active — drop-in written for future use"
  fi
}

restart_dnsmasq() {
  print_header "Starting dnsmasq"

  log "ACTION: restarting dnsmasq"
  if systemctl is-enabled dnsmasq &>/dev/null 2>&1; then
    sudo systemctl restart dnsmasq
  else
    sudo systemctl enable --now dnsmasq
  fi
  print_status "dnsmasq restarted"
}

verify_dnsmasq_active() {
  print_header "Verifying dnsmasq"

  # Check dnsmasq is active
  if systemctl is-active --quiet dnsmasq 2>/dev/null; then
    print_status "dnsmasq service is active"
  else
    print_error "dnsmasq service is NOT active"
    echo "  Run: sudo systemctl status dnsmasq"
    return 1
  fi

  # Check dnsmasq is listening on 5353
  if ss -tlnp 2>/dev/null | grep -q ':5353 '; then
    print_status "dnsmasq is listening on port 5353"
  else
    print_warn "Cannot confirm dnsmasq listening on port 5353 (ss check)"
    echo "  This may be normal if ss lacks permissions. Try: sudo ss -tlnp | grep 5353"
  fi

  # Verify DNS resolution via dnsmasq on 5353
  if command -v dig &>/dev/null; then
    local result
    result=$(dig +short test.localhaus @127.0.0.1 -p 5353 2>/dev/null || true)
    if [[ "${result}" == "127.0.0.1" ]]; then
      print_status "dig test.localhaus @127.0.0.1 -p 5353 → 127.0.0.1"
    else
      print_warn "dig check returned: '${result}' (expected 127.0.0.1)"
      echo "  dnsmasq may need a moment. Try: dig test.localhaus @127.0.0.1 -p 5353"
    fi
  fi

  # Verify system resolver can resolve (via systemd-resolved forwarding)
  if command -v resolvectl &>/dev/null; then
    local result
    result=$(resolvectl query test.localhaus 2>/dev/null | grep -oP '127\.0\.0\.1' | head -1 || true)
    if [[ "${result}" == "127.0.0.1" ]]; then
      print_status "resolvectl query test.localhaus → 127.0.0.1 (systemd-resolved forwarding works)"
    else
      print_warn "resolvectl check inconclusive"
      echo "  Try: resolvectl query test.localhaus"
    fi
  fi
}

# --- WSL2 workaround ---

setup_wsl2() {
  print_header "WSL2 detected — skipping dnsmasq"

  print_warn "WSL2 runs its own DNS stub on port 53."
  print_warn "dnsmasq cannot be used reliably under WSL2."
  echo ""
  echo "  Instead, add entries to /etc/hosts for each project subdomain:"
  echo ""
  echo "    127.0.0.1 localhaus.localhaus"
  echo "    127.0.0.1 my-app.localhaus"
  echo ""
  echo "  After adding projects to localhaus, run the helper function below"
  echo "  to sync /etc/hosts with your registered subdomains:"
  echo ""
  echo '    localhaus-dns() {'
  echo '      sqlite3 ~/.localhaus/localhaus.db "SELECT subdomain FROM projects" | \'
  echo '        while read -r sub; do'
  echo '          grep -q "${sub}.localhaus" /etc/hosts || \'
  echo '            echo "127.0.0.1 ${sub}.localhaus # localhaus-managed" | sudo tee -a /etc/hosts'
  echo '        done'
  echo '    }'
  echo ""
  echo "  Add this function to your ~/.bashrc or ~/.zshrc."
  echo ""
  log "SKIP: dnsmasq skipped (WSL2)"
  log "INFO: user instructed to use /etc/hosts helper"

  # Write a base hosts entry for the dashboard (with marker comment for safe teardown)
  if ! grep -qF "localhaus.localhaus" /etc/hosts 2>/dev/null; then
    echo "127.0.0.1 localhaus.localhaus # localhaus-managed" | sudo tee -a /etc/hosts > /dev/null
    log "ACTION: added localhaus.localhaus to /etc/hosts"
    print_status "Added localhaus.localhaus to /etc/hosts"
  else
    print_status "localhaus.localhaus already in /etc/hosts"
  fi
}

# --- mkcert ---

install_mkcert() {
  print_header "Setting up mkcert"

  if command -v mkcert &>/dev/null; then
    print_status "mkcert already installed"
    return 0
  fi

  local pm
  pm=$(detect_pkg_manager)

  # Try package manager first
  local installed=false
  case "${pm}" in
    apt)
      if apt-cache show mkcert &>/dev/null 2>&1; then
        pkg_install mkcert
        installed=true
      fi
      ;;
    dnf)
      if dnf info mkcert &>/dev/null 2>&1; then
        pkg_install mkcert
        installed=true
      fi
      ;;
    pacman)
      pkg_install mkcert
      installed=true
      ;;
  esac

  if [[ "${installed}" == "false" ]]; then
    # Fall back to downloading from GitHub
    print_warn "mkcert not available via package manager, downloading from GitHub..."
    local arch
    arch=$(uname -m)
    case "${arch}" in
      x86_64)  arch="amd64" ;;
      aarch64) arch="arm64" ;;
      armv7l)  arch="arm" ;;
      *)
        print_error "Unsupported architecture: ${arch}"
        exit 1
        ;;
    esac

    local mkcert_url="https://dl.filippo.io/mkcert/latest?for=linux/${arch}"
    log "ACTION: downloading mkcert from ${mkcert_url}"
    sudo curl -fsSL "${mkcert_url}" -o /usr/local/bin/mkcert
    sudo chmod +x /usr/local/bin/mkcert
    print_status "mkcert downloaded to /usr/local/bin/mkcert"
  fi

  if ! check_command mkcert "mkcert installation failed."; then
    exit 1
  fi

  print_status "mkcert installed"
}

# --- Main ---

main() {
  print_header "localhaus Linux setup"

  check_linux
  setup_log

  log "Starting Linux setup"

  if is_wsl2; then
    setup_wsl2
  else
    local pm
    pm=$(detect_pkg_manager)
    if [[ -z "${pm}" ]]; then
      print_error "No supported package manager found (need apt, dnf, or pacman)."
      exit 1
    fi
    print_status "Detected package manager: ${pm}"

    install_dnsmasq
    configure_resolved
    restart_dnsmasq
    verify_dnsmasq_active
  fi

  install_mkcert
  generate_certs

  if ! is_wsl2; then
    verify_dns
  fi

  print_finish

  echo ""
  echo "  Target UX: https://localhaus.localhaus (no port)"
  echo "  Set LOCALHAUS_PORT=443 and LOCALHAUS_HTTPS=true in .env"
  echo "  On Linux, run: scripts/enable-low-port-bind-linux.sh"
  echo ""

  log "Linux setup complete"
}

main "$@"
