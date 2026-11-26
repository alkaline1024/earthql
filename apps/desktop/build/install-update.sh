#!/bin/bash
set -eu

parent_pid=$1
installed=$2
stage=$3
installed_version=$4
candidate="$stage/extracted/EarthQL.app"
backup="$stage/previous.app"
lock="$(/usr/bin/dirname "$installed")/.earthql-install-lock"

cleanup() {
  if [[ -e "$backup" ]]; then
    if [[ ! -e "$installed" ]]; then /bin/mv "$backup" "$installed" || true; fi
    if [[ -e "$backup" ]]; then return; fi
  fi
  /bin/rm -rf "$stage"
}
trap cleanup EXIT

fail() {
  /usr/bin/osascript -e 'display alert "EarthQL update could not be installed" message "Open EarthQL again to retry. If needed, reinstall it from EarthQL Releases." as critical' >/dev/null 2>&1 || true
  exit 1
}

for ((attempt=0; attempt<120; attempt++)); do
  if ! kill -0 "$parent_pid" 2>/dev/null; then break; fi
  /bin/sleep 0.5
done
if kill -0 "$parent_pid" 2>/dev/null; then fail; fi

if ! /bin/mkdir "$lock"; then fail; fi
trap 'cleanup; /bin/rmdir "$lock"' EXIT
current=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$installed/Contents/Info.plist") || fail
if [[ "$current" != "$installed_version" || -L "$installed" ]]; then fail; fi

/bin/mv "$installed" "$backup" || fail
if ! /bin/mv "$candidate" "$installed"; then
  /bin/mv "$backup" "$installed" || true
  fail
fi
if ! /usr/bin/open "$installed" --args "--earthql-updated-from=$installed_version"; then
  if /bin/mv "$installed" "$candidate"; then /bin/mv "$backup" "$installed" || true; fi
  fail
fi
/bin/rm -rf "$backup"
