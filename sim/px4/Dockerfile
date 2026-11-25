# PX4 SITL (software-in-the-loop) with PX4's built-in physics (SIH), headless.
#
# Built from plain Ubuntu so it runs natively on Apple Silicon (arm64) as well
# as x86: PX4's published dev images are amd64-only.
#
# Two stages: the first clones and compiles PX4 (~6 GB of source and toolchain);
# the image you run keeps only the compiled simulator (~100 MB).
#
#   docker compose build px4      # first build: ~10-20 min
#   docker compose up px4

# --- Stage 1: build -------------------------------------------------------------
FROM ubuntu:26.04 AS build

ARG PX4_VERSION=v1.16.2
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Toronto

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates sudo lsb-release tzdata \
 && rm -rf /var/lib/apt/lists/*

# Full (non-shallow) submodules: some are pinned to commits that a shallow fetch can't reach.
RUN git clone --branch ${PX4_VERSION} --recurse-submodules --jobs 8 \
      https://github.com/PX4/PX4-Autopilot.git /px4

WORKDIR /px4

# PX4's own dependency script. --no-nuttx: no flight-controller toolchain;
# --no-sim-tools: no Gazebo (SIH physics is built into PX4).
RUN bash ./Tools/setup/ubuntu.sh --no-nuttx --no-sim-tools \
 && rm -rf /var/lib/apt/lists/*

RUN make px4_sitl_default \
 # PX4 logs every flight at full rate (gigabytes over a session). Off by default here;
 # set PX4_LOGGING=1 on the container to turn it back on.
 && sed -i 's/^param set-default SDLOG_MODE 1$/param set-default SDLOG_MODE ${SDLOG_MODE:-1}/' \
      build/px4_sitl_default/etc/init.d-posix/rcS \
 && grep -q 'SDLOG_MODE ${SDLOG_MODE:-1}' build/px4_sitl_default/etc/init.d-posix/rcS

# --- Stage 2: run ----------------------------------------------------------------
FROM ubuntu:26.04

ARG PX4_VERSION=v1.16.2
ENV TZ=America/Toronto \
    PX4_VERSION=${PX4_VERSION}

# The binary only needs the C/C++ runtime, which the base image already has.
COPY --from=build /px4/build/px4_sitl_default/bin /px4/bin
COPY --from=build /px4/build/px4_sitl_default/etc /px4/etc
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# MAVLink over UDP: 14540 (offboard/API link, used by the bridge), 14550 (ground station).
EXPOSE 14540/udp 14550/udp 14580/udp 18570/udp

ENTRYPOINT ["/entrypoint.sh"]
