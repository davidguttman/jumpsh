#!/usr/bin/env bash
# setup-linux.sh — Linux setup for localhaus (dnsmasq + mkcert)
# Installs wildcard DNS for *.localhost and generates TLS certificates.
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

  local dnsmasq_conf_dir="/etc/dnsmasq.d"
  local dnsmasq_conf="${dnsmasq_conf_dir}/localhost.conf"
  local target_line="address=/.localhost/127.0.0.1"

  sudo mkdir -p "${dnsmasq_conf_dir}"

  if [[ -f "${dnsmasq_conf}" ]] && grep -qF "${target_line}" "${dnsmasq_conf}"; then
    print_status "dnsmasq already configured for *.localhost"
  else
    echo "${target_line}" | sudo tee "${dnsmasq_conf}" > /dev/null
    log "ACTION: wrote ${dnsmasq_conf}"
    print_status "Configured dnsmasq for *.localhost"
  fi
}

# --- systemd-resolved integration ---

configure_resolved() {
  # If systemd-resolved is running, configure it to forward .localhost to dnsmasq
  if ! systemctl is-active --quiet systemd-resolved 2>/dev/null; then
    return 0
  fi

  print_header "Configuring systemd-resolved"

  local resolved_drop_dir="/etc/systemd/resolved.conf.d"
  local resolved_conf="${resolved_drop_dir}/localhaus.conf"

  if [[ -f "${resolved_conf}" ]]; then
    print_status "systemd-resolved drop-in already exists"
  else
    sudo mkdir -p "${resolved_drop_dir}"
    sudo tee "${resolved_conf}" > /dev/null <<'EOF'
# Added by localhaus setup — forwards .localhost queries to dnsmasq
[Resolve]
DNS=127.0.0.1
Domains=~localhost
EOF
    log "ACTION: wrote ${resolved_conf}"
    print_status "Created systemd-resolved drop-in for .localhost"
  fi

  # Check if dnsmasq needs to listen on an alternate port (53 may be taken by resolved stub)
  if ss -tlnp 2>/dev/null | grep -q ':53 .*systemd-resolve'; then
    # Configure dnsmasq to bind on a different port and have resolved forward to it
    local dnsmasq_port_conf="/etc/dnsmasq.d/localhaus-port.conf"
    if [[ ! -f "${dnsmasq_port_conf}" ]]; then
      sudo tee "${dnsmasq_port_conf}" > /dev/null <<'EOF'
# localhaus: dnsmasq listens on 5353 to avoid conflict with systemd-resolved stub
port=5353
listen-address=127.0.0.1
bind-interfaces
EOF
      log "ACTION: wrote ${dnsmasq_port_conf} (port 5353)"

      # Update resolved drop-in to point to port 5353
      sudo tee "${resolved_conf}" > /dev/null <<'EOF'
# Added by localhaus setup — forwards .localhost queries to dnsmasq on port 5353
[Resolve]
DNS=127.0.0.1:5353
Domains=~localhost
EOF
      log "ACTION: updated ${resolved_conf} to use port 5353"
      print_status "Configured dnsmasq on port 5353 (systemd-resolved on 53)"
    else
      print_status "dnsmasq port config already exists"
    fi
  fi

  log "ACTION: restarting systemd-resolved"
  sudo systemctl restart systemd-resolved
  print_status "systemd-resolved restarted"
}

restart_dnsmasq() {
  log "ACTION: restarting dnsmasq"
  if systemctl is-enabled dnsmasq &>/dev/null 2>&1; then
    sudo systemctl restart dnsmasq
  else
    sudo systemctl enable --now dnsmasq
  fi
  print_status "dnsmasq restarted"
}

# --- WSL2 workaround ---

setup_wsl2() {
  print_header "WSL2 detected — skipping dnsmasq"

  print_warn "WSL2 runs its own DNS stub on port 53."
  print_warn "dnsmasq cannot be used reliably under WSL2."
  echo ""
  echo "  Instead, add entries to /etc/hosts for each project subdomain:"
  echo ""
  echo "    127.0.0.1 localhaus.localhost"
  echo "    127.0.0.1 my-app.localhost"
  echo ""
  echo "  After adding projects to localhaus, run the helper function below"
  echo "  to sync /etc/hosts with your registered subdomains:"
  echo ""
  echo '    localhaus-dns() {'
  echo '      sqlite3 ~/.localhaus/localhaus.db "SELECT subdomain FROM projects" | \'
  echo '        while read -r sub; do'
  echo '          grep -q "${sub}.localhost" /etc/hosts || \'
  echo '            echo "127.0.0.1 ${sub}.localhost # localhaus-managed" | sudo tee -a /etc/hosts'
  echo '        done'
  echo '    }'
  echo ""
  echo "  Add this function to your ~/.bashrc or ~/.zshrc."
  echo ""
  log "SKIP: dnsmasq skipped (WSL2)"
  log "INFO: user instructed to use /etc/hosts helper"

  # Write a base hosts entry for the dashboard (with marker comment for safe teardown)
  if ! grep -qF "localhaus.localhost" /etc/hosts 2>/dev/null; then
    echo "127.0.0.1 localhaus.localhost # localhaus-managed" | sudo tee -a /etc/hosts > /dev/null
    log "ACTION: added localhaus.localhost to /etc/hosts"
    print_status "Added localhaus.localhost to /etc/hosts"
  else
    print_status "localhaus.localhost already in /etc/hosts"
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
  fi

  install_mkcert
  generate_certs

  if ! is_wsl2; then
    verify_dns
  fi

  print_finish

  log "Linux setup complete"
}

main "$@"
