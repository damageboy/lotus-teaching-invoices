#!/usr/bin/env bash
set -euo pipefail

readonly MODE="${1:-}"
readonly TARGET_KIND="${2:-}"
readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly APK_ROOT="$PROJECT_ROOT/src-tauri/gen/android/app/build/outputs/apk"
readonly APP_COMPONENT="com.houmus.teaching_invoices/.MainActivity"

usage() {
  cat >&2 <<EOF
Usage: ${0##*/} <debug|release> <device|emulator> [options]

Options:
  --device <adb-serial>  Select a connected adb target
  --avd <name>           Select the AVD to start in emulator mode
  -h, --help             Show this help
EOF
}

if [[ "$MODE" == "-h" || "$MODE" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "$MODE" != "debug" && "$MODE" != "release" ]] ||
  [[ "$TARGET_KIND" != "device" && "$TARGET_KIND" != "emulator" ]]; then
  usage
  exit 2
fi
shift 2

REQUESTED_SERIAL=""
REQUESTED_AVD=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
  --device)
    if [[ "$#" -lt 2 ]]; then
      printf 'error: --device requires an adb serial\n' >&2
      exit 2
    fi
    REQUESTED_SERIAL="$2"
    shift 2
    ;;
  --avd)
    if [[ "$#" -lt 2 ]]; then
      printf 'error: --avd requires an AVD name\n' >&2
      exit 2
    fi
    REQUESTED_AVD="$2"
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    printf 'error: unknown argument: %s\n' "$1" >&2
    usage
    exit 2
    ;;
  esac
done

find_sdk_tool() {
  local tool="$1"
  local path

  path="$(command -v "$tool" || true)"
  if [[ -n "$path" ]]; then
    printf '%s\n' "$path"
    return 0
  fi

  for path in \
    "${ANDROID_HOME:-}/platform-tools/$tool" \
    "${ANDROID_SDK_ROOT:-}/platform-tools/$tool" \
    "$HOME/Library/Android/sdk/platform-tools/$tool" \
    "${ANDROID_HOME:-}/emulator/$tool" \
    "${ANDROID_SDK_ROOT:-}/emulator/$tool" \
    "$HOME/Library/Android/sdk/emulator/$tool"; do
    if [[ -x "$path" ]]; then
      printf '%s\n' "$path"
      return 0
    fi
  done

  return 1
}

find_sdk_build_tool() {
  local tool="$1"
  local path sdk found=""

  path="$(command -v "$tool" || true)"
  if [[ -n "$path" ]]; then
    printf '%s\n' "$path"
    return 0
  fi

  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk"; do
    if [[ -z "$sdk" || ! -d "$sdk/build-tools" ]]; then
      continue
    fi
    for path in "$sdk"/build-tools/*/"$tool"; do
      if [[ -x "$path" ]]; then
        found="$path"
      fi
    done
  done

  if [[ -n "$found" ]]; then
    printf '%s\n' "$found"
    return 0
  fi
  return 1
}

sign_local_release() {
  local unsigned_apk="$1"
  local signer keystore signed_apk

  signer="$(find_sdk_build_tool apksigner || true)"
  if [[ -z "$signer" ]]; then
    printf 'error: apksigner was not found; install Android SDK Build Tools\n' >&2
    return 1
  fi

  keystore="${ANDROID_DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
  if [[ ! -f "$keystore" ]]; then
    printf 'error: Android debug keystore not found at %s; run a debug Android build first\n' "$keystore" >&2
    return 1
  fi

  signed_apk="${unsigned_apk%-unsigned.apk}-local.apk"
  "$signer" sign \
    --ks "$keystore" \
    --ks-key-alias androiddebugkey \
    --ks-pass pass:android \
    --key-pass pass:android \
    --out "$signed_apk" \
    "$unsigned_apk"
  "$signer" verify "$signed_apk"
  printf '%s\n' "$signed_apk"
}

ADB="$(find_sdk_tool adb || true)"
if [[ -z "$ADB" ]]; then
  printf 'error: adb was not found; add Android SDK platform-tools to PATH or set ANDROID_HOME\n' >&2
  exit 1
fi

refresh_devices() {
  DEVICE_SERIALS=()
  EMULATOR_SERIALS=()
  while IFS= read -r line; do
    read -r serial state _ <<<"$line"
    if [[ "${state:-}" != "device" ]]; then
      continue
    fi
    if [[ "$serial" == emulator-* ]]; then
      EMULATOR_SERIALS+=("$serial")
    else
      DEVICE_SERIALS+=("$serial")
    fi
  done < <("$ADB" devices -l | tail -n +2)
}

contains_serial() {
  local requested="$1"
  shift
  local serial
  for serial in "$@"; do
    if [[ "$serial" == "$requested" ]]; then
      return 0
    fi
  done
  return 1
}

choose_only_serial() {
  local kind="$1"
  shift
  local serials=("$@")
  if [[ "${#serials[@]}" -eq 1 ]]; then
    printf '%s\n' "${serials[0]}"
    return 0
  fi

  printf 'error: expected exactly one ready %s, found %d\n' "$kind" "${#serials[@]}" >&2
  if [[ "${#serials[@]}" -gt 0 ]]; then
    printf 'Specify one with --device <serial>:\n' >&2
    local index
    for ((index = 0; index < ${#serials[@]}; index++)); do
      printf '%d) %s\n' "$((index + 1))" "${serials[index]}" >&2
    done
  fi
  return 1
}

start_emulator() {
  local emulator avd
  local avds=()
  emulator="$(find_sdk_tool emulator || true)"
  if [[ -z "$emulator" ]]; then
    printf 'error: emulator was not found; add the Android SDK emulator directory to PATH or set ANDROID_HOME\n' >&2
    return 1
  fi

  while IFS= read -r avd; do
    if [[ -n "$avd" ]]; then
      avds+=("$avd")
    fi
  done < <("$emulator" -list-avds)

  if [[ -n "$REQUESTED_AVD" ]]; then
    if ! contains_serial "$REQUESTED_AVD" "${avds[@]}"; then
      printf 'error: AVD %s was not found\n' "$REQUESTED_AVD" >&2
      return 1
    fi
    avd="$REQUESTED_AVD"
  elif [[ "${#avds[@]}" -eq 1 ]]; then
    avd="${avds[0]}"
  else
    printf 'error: expected exactly one available AVD, found %d\n' "${#avds[@]}" >&2
    if [[ "${#avds[@]}" -gt 0 ]]; then
      printf 'Specify one with --avd <name>:\n' >&2
      printf '  %s\n' "${avds[@]}" >&2
    fi
    return 1
  fi

  printf 'Starting Android emulator AVD %s...\n' "$avd"
  nohup "$emulator" -avd "$avd" >"${TMPDIR:-/tmp}/lotus-android-emulator.log" 2>&1 &
}

wait_for_emulator() {
  local attempt
  for ((attempt = 0; attempt < 120; attempt++)); do
    refresh_devices
    if [[ "${#EMULATOR_SERIALS[@]}" -eq 1 ]]; then
      printf '%s\n' "${EMULATOR_SERIALS[0]}"
      return 0
    fi
    sleep 1
  done
  printf 'error: timed out waiting for the emulator to register with adb\n' >&2
  return 1
}

wait_for_boot() {
  local serial="$1"
  local attempt booted
  for ((attempt = 0; attempt < 180; attempt++)); do
    booted="$("$ADB" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    if [[ "$booted" == "1" ]]; then
      return 0
    fi
    sleep 1
  done
  printf 'error: timed out waiting for Android to finish booting on %s\n' "$serial" >&2
  return 1
}

refresh_devices
if [[ "$TARGET_KIND" == "device" ]]; then
  if [[ -n "$REQUESTED_AVD" ]]; then
    printf 'error: --avd can only be used in emulator mode\n' >&2
    exit 2
  fi
  if [[ -n "$REQUESTED_SERIAL" ]]; then
    if ! contains_serial "$REQUESTED_SERIAL" "${DEVICE_SERIALS[@]}"; then
      printf 'error: USB device %s is not connected and ready\n' "$REQUESTED_SERIAL" >&2
      exit 1
    fi
    DEVICE_SERIAL="$REQUESTED_SERIAL"
  else
    DEVICE_SERIAL="$(choose_only_serial 'USB device' "${DEVICE_SERIALS[@]}")"
  fi
else
  if [[ -n "$REQUESTED_SERIAL" ]]; then
    if ! contains_serial "$REQUESTED_SERIAL" "${EMULATOR_SERIALS[@]}"; then
      printf 'error: emulator %s is not connected and ready\n' "$REQUESTED_SERIAL" >&2
      exit 1
    fi
    DEVICE_SERIAL="$REQUESTED_SERIAL"
  elif [[ "${#EMULATOR_SERIALS[@]}" -gt 0 ]]; then
    DEVICE_SERIAL="$(choose_only_serial 'emulator' "${EMULATOR_SERIALS[@]}")"
  else
    start_emulator
    DEVICE_SERIAL="$(wait_for_emulator)"
  fi
  wait_for_boot "$DEVICE_SERIAL"
fi
readonly DEVICE_SERIAL

rm -rf "$APK_ROOT"
BUILD_ARGS=(tauri android build --apk --target aarch64)
if [[ "$MODE" == "debug" ]]; then
  BUILD_ARGS+=(--debug)
fi
(
  cd "$PROJECT_ROOT"
  bunx "${BUILD_ARGS[@]}"
)

APK_PATH="$(find "$APK_ROOT" -type f -path "*/$MODE/*.apk" ! -name '*androidTest*.apk' -print -quit)"
if [[ -z "$APK_PATH" ]]; then
  printf 'error: the Android build completed without producing a %s APK\n' "$MODE" >&2
  exit 1
fi
if [[ "$APK_PATH" == *-unsigned.apk ]]; then
  APK_PATH="$(sign_local_release "$APK_PATH")"
fi

"$ADB" -s "$DEVICE_SERIAL" install -r "$APK_PATH"
"$ADB" -s "$DEVICE_SERIAL" shell am start -n "$APP_COMPONENT"
