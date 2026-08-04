FROM temporalio/auto-setup:1.29.7@sha256:f14912b699cf73015ad5c4fc18d522d4b014db90e794039214dfb7c022c2644f
COPY infra/temporal/dynamicconfig.yaml /etc/temporal/config/dynamicconfig/development.yaml
USER temporal
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["sh", "-c", "kill -0 1"]
