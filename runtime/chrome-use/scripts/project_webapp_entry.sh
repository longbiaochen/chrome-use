#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${1:-}"
if [[ -z "$PROJECT_ROOT" || ! -d "$PROJECT_ROOT" ]]; then
  exit 0
fi

normalize_and_trim() {
  local value="$1"
  if [[ -z "$value" ]]; then
    return
  fi

  local random_value="$RANDOM"
  value="${value//\$\{RANDOM\}/$random_value}"
  value="${value//\$RANDOM/$random_value}"
  value="$(printf '%s' "$value" | sed -E "s/^[[:space:]\"'(]+//; s/[[:space:],.;\)\]]+$//")"

  if [[ ! "$value" =~ ^https?:// ]]; then
    return
  fi

  case "$value" in
    */) printf '%s\n' "$value" ;;
    *) printf '%s/\n' "$value" ;;
  esac
}

extract_http_url_from_text() {
  printf '%s\n' "$1" | grep -oE "https?://[^[:space:]\"'()\\],;]+" | head -n 1 || true
}

extract_http_url() {
  local file="$1"
  local found
  found="$(extract_http_url_from_text "$(cat "$file")" || true)"
  if [[ -n "${found:-}" ]]; then
    echo "$found"
  fi
}

parse_make_target_body() {
  local target="$1"
  local makefile="$PROJECT_ROOT/Makefile"
  awk -v target="$target" '
    $1 == target ":" { in_target = 1; next }
    in_target && /^[[:space:]]*[^[:space:]].*:/ { exit }
    in_target && /^[[:space:]]+/ {
      sub(/^[[:space:]]+/, "", $0);
      print;
    }
  ' "$makefile"
}

resolve_default_port() {
  local makefile="$PROJECT_ROOT/Makefile"
  awk 'BEGIN { port = "" }
    /^[[:space:]]*PORT[[:space:]]*[:?]?=[[:space:]]*[0-9]+[[:space:]]*$/ {
      match($0, /[0-9]+/);
      if (RSTART) {
        port = substr($0, RSTART, RLENGTH);
      }
    }
    END { if (port != "") print port; }' "$makefile" | head -n 1
}

resolve_from_line() {
  local line="$1"
  local default_port
  default_port="$(resolve_default_port)"

  if [[ "$line" == *"http://"* || "$line" == *"https://"* ]]; then
    local line_url
    line_url="$(extract_http_url_from_text "$line")"
    if [[ -n "${line_url:-}" ]]; then
      normalize_and_trim "$line_url"
      return 0
    fi
  fi

  if [[ "$line" == *" -p "* ]] && [[ "$line" =~ -p[[:space:]]+([0-9]+) ]]; then
    echo "http://127.0.0.1:${BASH_REMATCH[1]}/"
    return 0
  fi

  if [[ "$line" == *" -p "* ]] && [[ "$line" =~ -p[[:space:]]+\$[\(\{]PORT[\)\}] ]]; then
    echo "http://127.0.0.1:${default_port:-8000}/"
    return 0
  fi

  if [[ "$line" == *"\$(PORT)"* || "$line" == *"\${PORT}"* ]]; then
    echo "http://127.0.0.1:${default_port:-8000}/"
    return 0
  fi

  if [[ "$line" == *" http.server "* ]] && [[ "$line" =~ -m[[:space:]]+http\.server[[:space:]]+([0-9]+) ]]; then
    echo "http://127.0.0.1:${BASH_REMATCH[1]}/"
    return 0
  fi

  if [[ "$line" == *" http.server "* ]]; then
    echo "http://127.0.0.1:8000/"
    return 0
  fi

  return 1
}

if [[ -f "$PROJECT_ROOT/build.sh" ]]; then
  build_url="$(extract_http_url "$PROJECT_ROOT/build.sh" || true)"
  if [[ -n "${build_url:-}" ]]; then
    normalize_and_trim "$build_url"
    exit 0
  fi
fi

if [[ -f "$PROJECT_ROOT/Makefile" ]]; then
  for target in devserver serve serve-global; do
    target_body="$(parse_make_target_body "$target" | sed '/^$/d' || true)"
    if [[ -z "${target_body:-}" ]]; then
      continue
    fi
    while IFS= read -r line; do
      if [[ -n "${line:-}" ]] && resolve_from_line "$line"; then
        exit 0
      fi
    done <<< "$target_body"
  done
fi

echo ""
