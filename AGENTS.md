# chrome-use Maintenance Notes

- This repo owns the `chrome-inspect` / `chrome-auth` runtime and install surface for explicit Chrome CDP work on this machine.
- Current runtime contract: use a managed `Chrome for Testing` browser plus a dedicated `~/.chrome-use/browser-data/<channel-or-version>` user-data-dir over CDP instead of attaching to the user's `Google Chrome.app` `Default` profile or maintaining an app shim.

## Repo Scope

- Public browser skill names in this repo:
  - `chrome-auth`
  - `chrome-inspect`
- Shared runtime lives under `runtime/chrome-use/`.

## Canonical Commands

- Installer entrypoint:
  - `bash install/install.sh`
- Client-specific installers:
  - `bash install/install-codex-skill.sh`
  - `bash install/install-agent-skill.sh`
- Runtime validation:
  - `bash scripts/verify-manifest.sh`
  - `bash scripts/test-runtime.sh`
  - `bash runtime/chrome-use/scripts/doctor.sh`
  - `~/.chrome-use/bin/chrome-use-open-google-chrome`

## Maintenance Rules

- Keep packaging cross-agent and cross-platform when working in this repo.
- Keep Codex-specific metadata optional and isolated.
- Validate changes through this repo's own install and runtime checks plus a real local attach to the managed `Chrome for Testing` browser, not just mocked runtime output.
