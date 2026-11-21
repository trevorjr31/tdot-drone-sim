"""
Smoke test for the PX4 SITL container: connect over MAVLink (MAVSDK), check
the drone's home is in Toronto, then arm, take off, hover, and land.

Run it inside PX4's network namespace so it sees PX4's UDP traffic on localhost:

    docker run --rm --network container:tdot-px4 -v "$PWD/sim/tools:/tools:ro" \
      python:3.12-slim sh -c "pip install -q -r /tools/requirements.txt && python /tools/flight_test.py"

Uses `mavsdk-grpc`: MAVSDK-Python's long-standing gRPC API, which moved to this
package name when `mavsdk` v4 switched to a new native API.
"""

import asyncio
import os
import sys

from mavsdk_grpc import System

# PX4's ground-station link (14550), so this can run while the bridge holds the API link (14540).
MAVLINK_URL = os.environ.get("MAVLINK_URL", "udpin://0.0.0.0:14550")
TAKEOFF_ALT_M = 20.0
# Rough box around the City of Toronto, to confirm the home position took effect.
TORONTO_BOX = {"lat": (43.58, 43.86), "lon": (-79.64, -79.11)}


async def first(stream, timeout, what):
    """First item from a MAVSDK telemetry stream, or fail with a clear message."""
    try:
        async with asyncio.timeout(timeout):
            async for item in stream:
                return item
    except TimeoutError:
        sys.exit(f"FAIL: timed out after {timeout}s waiting for {what}")


async def wait_for(stream, predicate, timeout, what):
    try:
        async with asyncio.timeout(timeout):
            async for item in stream:
                if predicate(item):
                    return item
    except TimeoutError:
        sys.exit(f"FAIL: timed out after {timeout}s waiting for {what}")


async def main():
    drone = System()
    await drone.connect(system_address=MAVLINK_URL)

    print("Waiting for PX4…")
    await wait_for(drone.core.connection_state(), lambda s: s.is_connected, 60, "connection")
    info = await drone.info.get_version()
    print(f"Connected: PX4 {info.flight_sw_major}.{info.flight_sw_minor}.{info.flight_sw_patch}")

    await wait_for(
        drone.telemetry.health(),
        lambda h: h.is_global_position_ok and h.is_home_position_ok,
        90,
        "GPS fix and home position",
    )
    home = await first(drone.telemetry.home(), 10, "home position")
    print(f"Home: {home.latitude_deg:.5f}, {home.longitude_deg:.5f}, {home.absolute_altitude_m:.1f} m AMSL")
    in_toronto = (
        TORONTO_BOX["lat"][0] < home.latitude_deg < TORONTO_BOX["lat"][1]
        and TORONTO_BOX["lon"][0] < home.longitude_deg < TORONTO_BOX["lon"][1]
    )
    print(f"Home is in Toronto: {'yes' if in_toronto else 'NO'}")
    if not in_toronto:
        sys.exit("FAIL: home position is not in Toronto (check PX4_HOME_* env vars)")

    print("Arming…")
    await drone.action.arm()
    await drone.action.set_takeoff_altitude(TAKEOFF_ALT_M)
    print(f"Taking off to {TAKEOFF_ALT_M:.0f} m…")
    await drone.action.takeoff()

    pos = await wait_for(
        drone.telemetry.position(),
        lambda p: p.relative_altitude_m > TAKEOFF_ALT_M - 1.5,
        60,
        "takeoff altitude",
    )
    print(f"Airborne: {pos.latitude_deg:.5f}, {pos.longitude_deg:.5f}, {pos.relative_altitude_m:.1f} m above home")

    print("Hovering for 5 s…")
    await asyncio.sleep(5)
    pos = await first(drone.telemetry.position(), 5, "position")
    att = await first(drone.telemetry.attitude_euler(), 5, "attitude")
    print(f"Still at {pos.relative_altitude_m:.1f} m; heading {att.yaw_deg:.0f}°, roll {att.roll_deg:.1f}°, pitch {att.pitch_deg:.1f}°")

    print("Landing…")
    await drone.action.land()
    await wait_for(drone.telemetry.in_air(), lambda in_air: not in_air, 90, "landing")
    print("PASS: landed")


if __name__ == "__main__":
    asyncio.run(main())
