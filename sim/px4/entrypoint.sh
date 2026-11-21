#!/usr/bin/env bash
# Starts PX4 SITL with the SIH quadcopter, headless.
#
# Home position comes from PX4_HOME_LAT / PX4_HOME_LON / PX4_HOME_ALT
# (altitude in metres above mean sea level), set in docker-compose.yml.
set -euo pipefail

cd /px4

echo "Starting PX4 SITL ($(git describe --tags 2>/dev/null || echo unknown)) model=${PX4_SIM_MODEL:-sihsim_quadx}"
echo "Home: lat=${PX4_HOME_LAT:-?} lon=${PX4_HOME_LON:-?} alt=${PX4_HOME_ALT:-?} m AMSL"

# `make <target> <model>` runs the already-built binary (the build step is a no-op).
exec make px4_sitl "${PX4_SIM_MODEL:-sihsim_quadx}"
