#!/usr/bin/env bash
# Starts PX4 SITL with the SIH quadcopter, headless.
#
# Home position comes from PX4_HOME_LAT / PX4_HOME_LON / PX4_HOME_ALT
# (altitude in metres above mean sea level), set in docker-compose.yml.
# PX4_LOGGING=1 turns PX4's onboard flight logging back on (off by default: it
# writes gigabytes over a session into /px4/log).
set -euo pipefail

model="${PX4_SIM_MODEL:-sihsim_quadx}"
echo "Starting PX4 SITL (${PX4_VERSION:-unknown}) model=${model}"
echo "Home: lat=${PX4_HOME_LAT:-?} lon=${PX4_HOME_LON:-?} alt=${PX4_HOME_ALT:-?} m AMSL"

if [ "${PX4_LOGGING:-0}" = "1" ]; then export SDLOG_MODE=1; else export SDLOG_MODE=-1; fi

# Same as `make px4_sitl sihsim_quadx`, without needing the source tree: PX4 finds its
# startup scripts in /px4/etc and keeps its state (params, dataman, logs) in /px4.
cd /px4
exec env PX4_SIM_MODEL="${model}" PX4_SIMULATOR=sihsim /px4/bin/px4
