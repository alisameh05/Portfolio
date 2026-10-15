# Tools only: source and Git metadata are mounted read-only at runtime.
FROM docker@sha256:3ef33f2e220b79ed3ef3b99d81746f06f306cd6340e2cb7331d17ae996e74cb6 AS engine
FROM node@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git iptables iproute2 xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@11.19.0 --no-audit --no-fund
COPY --from=engine /usr/local/bin/docker /usr/local/bin/dockerd /usr/local/bin/containerd /usr/local/bin/containerd-shim-runc-v2 /usr/local/bin/ctr /usr/local/bin/runc /usr/local/bin/docker-proxy /usr/local/bin/docker-init /usr/local/bin/dind /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/portfolio-validation
RUN chmod 755 /usr/local/bin/portfolio-validation
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/portfolio-validation"]
CMD ["phase6"]
