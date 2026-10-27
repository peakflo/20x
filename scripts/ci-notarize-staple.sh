#!/bin/bash
# Notarize a macOS artifact with notarytool and/or staple the ticket, retrying the
# network-bound steps. Apple's ticket CDN (api.apple-cloudkit.com) sometimes drops
# connections right after a submission is Accepted (NSURLErrorDomain -1005,
# stapler "Error 68").
#
# On GitHub's macos-15-intel runners this happens on most stapler calls
# (actions/runner-images#14924), so the release workflow notarizes x64 builds
# there with --notarize-only and staples them on an Apple-silicon runner with
# --staple-only.
#
# Usage:
#   ci-notarize-staple.sh <submit-path> <staple-path> [--assess] [--notarize-only]
#   ci-notarize-staple.sh --staple-only <staple-path> [--assess]
#
#   submit-path      file uploaded to the notary service (.zip / .dmg)
#   staple-path      file/bundle the ticket is stapled to (.app / .dmg)
#   --assess         also run `spctl --assess --type execute` on staple-path
#   --notarize-only  submit and wait for Accepted, but do not staple
#   --staple-only    skip notarization (ticket must already exist), only staple
#                    and validate; Apple credentials are not needed
#
# Notarization requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.
# NOTARIZE_RETRY_ATTEMPTS (default 5) and NOTARIZE_RETRY_DELAY (initial delay in
# seconds, default 15, doubled after each failed attempt) tune the retry loop.
set -euo pipefail

MODE="full"
ASSESS=""
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --assess) ASSESS="yes" ;;
    --notarize-only) MODE="notarize" ;;
    --staple-only) MODE="staple" ;;
    --*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

if [ "$MODE" = "staple" ]; then
  [ "${#POSITIONAL[@]}" -eq 1 ] || { echo "Usage: $0 --staple-only <staple-path> [--assess]" >&2; exit 2; }
  SUBMIT_PATH=""
  STAPLE_PATH="${POSITIONAL[0]}"
else
  [ "${#POSITIONAL[@]}" -eq 2 ] || { echo "Usage: $0 <submit-path> <staple-path> [--assess] [--notarize-only]" >&2; exit 2; }
  SUBMIT_PATH="${POSITIONAL[0]}"
  STAPLE_PATH="${POSITIONAL[1]}"
fi

ATTEMPTS="${NOTARIZE_RETRY_ATTEMPTS:-5}"
INITIAL_DELAY="${NOTARIZE_RETRY_DELAY:-15}"

retry() {
  local attempt=1
  local delay="$INITIAL_DELAY"
  local status
  while true; do
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if [ "$attempt" -ge "$ATTEMPTS" ]; then
      echo "::error::'$*' failed after $attempt attempts (exit $status)" >&2
      return "$status"
    fi
    echo "::warning::'$*' failed (exit $status), attempt $attempt/$ATTEMPTS; retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

json_field() {
  python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1"
}

notarize() {
  : "${APPLE_ID:?APPLE_ID is required}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required}"
  : "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
  notary_auth=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")

  SUBMISSION_ID=""
  retry submit
  echo "Notary submission id: $SUBMISSION_ID"

  retry xcrun notarytool wait "$SUBMISSION_ID" "${notary_auth[@]}"

  NOTARY_STATUS=""
  retry info_status
  if [ "$NOTARY_STATUS" != "Accepted" ]; then
    echo "::error::Notarization of $SUBMIT_PATH finished with status '$NOTARY_STATUS'" >&2
    xcrun notarytool log "$SUBMISSION_ID" "${notary_auth[@]}" || true
    exit 1
  fi
}

# Upload without --wait so a dropped connection while polling never causes a
# second submission: once we have an id we only poll that id.
submit() {
  local out
  out="$(xcrun notarytool submit "$SUBMIT_PATH" "${notary_auth[@]}" --output-format json)" || return $?
  echo "$out"
  SUBMISSION_ID="$(printf '%s' "$out" | json_field id)"
  [ -n "$SUBMISSION_ID" ]
}

info_status() {
  local out
  out="$(xcrun notarytool info "$SUBMISSION_ID" "${notary_auth[@]}" --output-format json)" || return $?
  echo "$out"
  NOTARY_STATUS="$(printf '%s' "$out" | json_field status)"
}

staple() {
  retry xcrun stapler staple "$STAPLE_PATH"
  retry xcrun stapler validate "$STAPLE_PATH"
}

if [ "$MODE" != "staple" ]; then
  notarize
fi

if [ "$MODE" != "notarize" ]; then
  staple
fi

if [ -n "$ASSESS" ]; then
  retry spctl --assess --type execute --verbose=4 "$STAPLE_PATH"
fi
