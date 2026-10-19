# A stand-in for a fresh cloud VM: Ubuntu 24.04 with systemd as PID 1 (docker-test.sh).
FROM ubuntu:24.04
RUN apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends systemd systemd-sysv curl ca-certificates iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-logind.service getty.target console-getty.service systemd-udevd.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
