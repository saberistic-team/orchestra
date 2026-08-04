FROM redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb
USER redis
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["redis-cli", "ping"]
