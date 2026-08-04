FROM codeberg.org/forgejo/forgejo:16.0.1-rootless@sha256:71863f6b6c5837a27b3a2d133c3161c78a432aa878d57798d74b1d917ff842be
COPY --chown=1000:1000 infra/forgejo-bootstrap/bootstrap.sh /usr/local/bin/orchestra-forgejo-bootstrap
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --retries=1 CMD ["sh", "-c", "true"]
ENTRYPOINT ["/usr/local/bin/orchestra-forgejo-bootstrap"]
