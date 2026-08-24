#!/usr/bin/env bash
# Install the public half of the CloudNativePG tunnel key on the current
# account. The matching private key lives in 1Password and Kubernetes only.

set -euo pipefail

PUBLIC_KEY_FILE="${1:-deploy/social-cnpg-tunnel.pub}"
if [ ! -s "$PUBLIC_KEY_FILE" ]; then
  echo "::error::$PUBLIC_KEY_FILE is missing or empty" >&2
  exit 1
fi

# Accept exactly one uncommented Ed25519 public key. Keeping options out of
# the committed key file makes the restriction below the single authority.
if ! awk '
  NF {
    lines++
    if (NF != 2 || $1 != "ssh-ed25519") invalid = 1
  }
  END { exit !(lines == 1 && !invalid) }
' "$PUBLIC_KEY_FILE"; then
  echo "::error::$PUBLIC_KEY_FILE must contain exactly one Ed25519 public key" >&2
  exit 1
fi
CNPG_TUNNEL_PUBLIC_KEY=$(awk 'NF { print $1 " " $2 }' "$PUBLIC_KEY_FILE")

SSH_DIR="${HOME:?HOME is required}/.ssh"
AUTHORIZED_KEYS="$SSH_DIR/authorized_keys"
AUTHORIZED_KEYS_TMP="$SSH_DIR/.authorized_keys.cnpg.tmp"
install -d -m 700 "$SSH_DIR"
touch "$AUTHORIZED_KEYS"
chmod 600 "$AUTHORIZED_KEYS"

# The deploy is single-flight, so one fixed temporary name is sufficient. A
# crash leaves the original file intact; the next run safely overwrites tmp.
awk '$NF != "social-cnpg-tunnel"' "$AUTHORIZED_KEYS" > "$AUTHORIZED_KEYS_TMP"
printf '%s %s %s\n' \
  'restrict,port-forwarding,permitopen="127.0.0.1:15432",command="/bin/false"' \
  "$CNPG_TUNNEL_PUBLIC_KEY" \
  'social-cnpg-tunnel' >> "$AUTHORIZED_KEYS_TMP"
chmod 600 "$AUTHORIZED_KEYS_TMP"
mv "$AUTHORIZED_KEYS_TMP" "$AUTHORIZED_KEYS"
