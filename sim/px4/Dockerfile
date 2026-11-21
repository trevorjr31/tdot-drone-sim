# PX4 SITL (software-in-the-loop) with PX4's built-in physics (SIH), headless.
#
# Built from plain Ubuntu so it runs natively on Apple Silicon (arm64) as well
# as x86: PX4's published dev images are amd64-only.
#
#   docker compose build px4      # first build: ~10-20 min
#   docker compose up px4

FROM ubuntu:22.04

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

# Compile SITL once at build time so containers start in seconds.
RUN make px4_sitl_default

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# MAVLink over UDP: 14540 (offboard/API link, used by the bridge), 14550 (ground station).
EXPOSE 14540/udp 14550/udp 14580/udp 18570/udp

ENTRYPOINT ["/entrypoint.sh"]
