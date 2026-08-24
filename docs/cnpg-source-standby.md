# CloudNativePG source standby

The single-server PostgreSQL instance remains the writer. This repository
only prepares it as a physical-replication source so a CloudNativePG cluster
can continuously follow it for testing and later cutover work.

## Source-side contract

- PostgreSQL is published on `127.0.0.1:15432` only. It is never reachable
  directly through the server's public interface.
- `postgres/pg_hba.replication.conf` authorizes physical replication only for
  `social_cnpg_replica` with SCRAM authentication, then includes the data
  volume's existing HBA rules unchanged.
- The source relies on the PostgreSQL 17 defaults for `wal_level` and WAL
  senders. It intentionally does not retain extra WAL for this testing mirror;
  if the standby falls too far behind, re-bootstrap it from the source.
- `scripts/deploy.sh` installs the dedicated forwarding key, materializes the
  database-only password file with mode `0600`, starts PostgreSQL, and creates
  or rotates the least-privilege replication role idempotently.
- The replication credential never enters the platform `.env` and is exposed
  only to the `usernode-db` container.

## Secret ownership

The source of truth is the `Cluster` 1Password vault:

- `Social Vibecoding CNPG replication` (`4ym4l6ydx7uy6axmgzcc3t6c5i`)
  supplies the GitHub Actions secret `SOCIAL_CNPG_REPLICATION_PASSWORD`.
- `Social Vibecoding CNPG SSH tunnel` (`jqvl7fkn7zi7ldlqlnxiq6fjru`)
  holds the private half of the key whose public half is committed at
  `deploy/social-cnpg-tunnel.pub`.

To rotate the database password, update the 1Password item, synchronize the
GitHub secret, then manually dispatch the **Deploy** workflow. The workflow
atomically rewrites the protected database env file and `ALTER ROLE` applies
the same password to PostgreSQL. Do not generate a second password on the
server.

To rotate the tunnel key, update the 1Password SSH-key item and committed
public key together, then deploy. The installer replaces only its marked
`social-cnpg-tunnel` line and preserves every unrelated authorized key.

## Cluster-side handoff

The cluster configuration must still provide:

- the tunnel private key and replication password through SOPS-managed
  Kubernetes secrets;
- the verified SSH host key for `144.76.85.53` (do not disable host-key
  checking);
- an SSH tunnel using the `deploy` account, forwarding a cluster-local port to
  source `127.0.0.1:15432`;
- the CloudNativePG external-cluster/bootstrap configuration pointing at that
  cluster-local tunnel endpoint.

Deploying this source-side change does not start replication and does not make
the cluster writable. The CloudNativePG replica remains read-only until an
explicit promotion/cutover operation.
