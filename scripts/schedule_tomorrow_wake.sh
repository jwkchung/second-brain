#!/bin/bash
# Optional macOS-only helper. Renews a one-off `pmset schedule wake` event so
# the Mac is awake for your nightly extraction job (scripts/nightly-extract-people.mjs)
# even if the laptop is closed/asleep at that time. Irrelevant if your
# scheduler already runs on an always-on machine or server.
#
# pmset supports only one *repeating* wake schedule per machine, so if you
# already use `pmset repeat` for something else, don't add a second repeat
# here — that's why this schedules a one-off `pmset schedule wake` entry for
# the next occurrence of TARGET_HOUR:TARGET_MIN instead, and re-runs itself
# daily (via a LaunchDaemon/cron job, as root — `pmset schedule` requires
# root) so that one-off entry keeps getting renewed for the next day.
# `pmset schedule wake` entries are additive, so this won't clobber any other
# wake schedule you already have.
#
# Run manually to check/renew immediately: scripts/schedule_tomorrow_wake.sh

set -euo pipefail

# Minutes before your extraction job fires — gives the machine time to
# actually wake up before the job needs to run.
WAKE_BUFFER_MIN="${WAKE_BUFFER_MIN:-5}"
TARGET_HOUR="${EXTRACT_HOUR:-02}"
TARGET_MIN="${EXTRACT_MIN:-55}"

LOG="${WAKE_LOG_PATH:-./logs/wake.out.log}"
mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" >>"$LOG"; }

now_epoch=$(date +%s)
today_target_epoch=$(date -j -f "%Y-%m-%d %H:%M:%S" "$(date +%Y-%m-%d) ${TARGET_HOUR}:${TARGET_MIN}:00" +%s)

if [ "$now_epoch" -lt "$today_target_epoch" ]; then
    target_date=$(date +%m/%d/%Y)
else
    target_date=$(date -v+1d +%m/%d/%Y)
fi

target="${target_date} ${TARGET_HOUR}:${TARGET_MIN}:00"

if /usr/bin/pmset schedule wake "$target" >>"$LOG" 2>&1; then
    log "scheduled wake at $target"
else
    log "FAILED to schedule wake at $target"
    exit 1
fi
