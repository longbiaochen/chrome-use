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
  [[ -f "$makefile" ]] || return 0
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
  [[ -f "$makefile" ]] || return 0
  awk 'BEGIN { port = "" }
    /^[[:space:]]*PORT[[:space:]]*[:?]?=[[:space:]]*[0-9]+[[:space:]]*$/ {
      match($0, /[0-9]+/);
      if (RSTART) {
        port = substr($0, RSTART, RLENGTH);
      }
    }
    END { if (port != "") print port; }' "$makefile" | head -n 1
}

read_package_script() {
  local package_dir="$1"
  local script_name="$2"

  node - "$package_dir" "$script_name" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const path = require("path");

const [packageDir, scriptName] = process.argv.slice(2);
try {
  const packageJsonPath = path.join(packageDir, "package.json");
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const value = parsed?.scripts?.[scriptName];
  if (typeof value === "string") {
    process.stdout.write(value);
  }
} catch {}
NODE
}

resolve_workspace_package_dir() {
  local package_name="$1"

  node - "$PROJECT_ROOT" "$package_name" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const path = require("path");

const [projectRoot, packageName] = process.argv.slice(2);

function listWorkspaceDirs(root, pattern) {
  if (!pattern.includes("*")) {
    const candidate = path.join(root, pattern);
    return fs.existsSync(path.join(candidate, "package.json")) ? [candidate] : [];
  }

  const starIndex = pattern.indexOf("*");
  const base = pattern.slice(0, starIndex).replace(/\/+$/, "");
  const suffix = pattern.slice(starIndex + 1).replace(/^\/+/, "");
  const baseDir = path.join(root, base);
  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
    return [];
  }

  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name, suffix))
    .filter((candidate) => fs.existsSync(path.join(candidate, "package.json")));
}

try {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : Array.isArray(rootPackage.workspaces?.packages)
      ? rootPackage.workspaces.packages
      : [];

  for (const pattern of workspaces) {
    for (const dir of listWorkspaceDirs(projectRoot, pattern)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        if (pkg?.name === packageName) {
          process.stdout.write(dir);
          process.exit(0);
        }
      } catch {}
    }
  }
} catch {}
NODE
}

resolve_effective_package_command() {
  local package_dir="$1"
  local script_name="$2"
  local script_body=""

  script_body="$(read_package_script "$package_dir" "$script_name")"
  if [[ -z "${script_body:-}" ]]; then
    return 1
  fi

  if [[ "$package_dir" == "$PROJECT_ROOT" ]] && [[ "$script_body" =~ npm[[:space:]]+--workspace[[:space:]]+([^[:space:]]+)[[:space:]]+run[[:space:]]+([[:alnum:]:_-]+) ]]; then
    local workspace_name="${BASH_REMATCH[1]}"
    local nested_script="${BASH_REMATCH[2]}"
    local workspace_dir=""
    local nested_body=""

    workspace_dir="$(resolve_workspace_package_dir "$workspace_name")"
    if [[ -n "${workspace_dir:-}" ]]; then
      nested_body="$(read_package_script "$workspace_dir" "$nested_script")"
      if [[ -n "${nested_body:-}" ]]; then
        printf '%s\n' "$nested_body"
        return 0
      fi
    fi
  fi

  printf '%s\n' "$script_body"
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

resolve_from_package_script() {
  local package_dir="$1"
  local script_name="$2"
  local line=""

  line="$(resolve_effective_package_command "$package_dir" "$script_name" || true)"
  if [[ -z "${line:-}" ]]; then
    return 1
  fi

  if resolve_from_line "$line"; then
    return 0
  fi

  case "$line" in
    *"next dev"*)
      echo "http://127.0.0.1:3000/"
      return 0
      ;;
    *"vite"*"dev"*|*"vite dev"*)
      echo "http://127.0.0.1:5173/"
      return 0
      ;;
    *"react-scripts start"*)
      echo "http://127.0.0.1:3000/"
      return 0
      ;;
  esac

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

if [[ -f "$PROJECT_ROOT/package.json" ]]; then
  for script_name in dev:web dev start:web start; do
    if resolve_from_package_script "$PROJECT_ROOT" "$script_name"; then
      exit 0
    fi
  done
fi

for package_dir in "$PROJECT_ROOT/apps/web" "$PROJECT_ROOT/web" "$PROJECT_ROOT/frontend"; do
  if [[ ! -f "$package_dir/package.json" ]]; then
    continue
  fi

  for script_name in dev start; do
    if resolve_from_package_script "$package_dir" "$script_name"; then
      exit 0
    fi
  done
done

echo ""
