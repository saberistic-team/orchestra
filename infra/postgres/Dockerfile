FROM postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
COPY infra/postgres/init.sql /docker-entrypoint-initdb.d/init.sql
USER postgres
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["pg_isready", "-U", "orchestra"]
