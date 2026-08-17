# Social Vibecoding Platform

This application-owned chart deploys the platform process and its PostgreSQL
database into `social-platform`. Generated applications, warm workers and
capture Jobs are created later by the platform through the scoped runtime
service account.

The `Build Kubernetes images` workflow first publishes three immutable images,
then packages their exact digests into `values.release.yaml` and publishes this
chart to `oci://ghcr.io/adonagy-corp/charts`. The chart is the atomic release
marker: no chart version exists unless all three image builds succeeded.

`main` publishes stable `0.1.x` chart versions tracked by Argo CD. The
`feat/k8s` branch publishes `0.0.x-feat-k8s` candidates that can be pulled and
rendered manually but are outside Argo's stable version constraint. Cluster
configuration and SOPS-encrypted secrets remain in the infra repository and
are applied as external Helm values.

`config.domain` is the single canonical domain expected by the application.
The platform is served at that hostname and generated applications use
`<slug>.<domain>` (with staging hosts beneath the same wildcard).

The OCI chart package must be public for unauthenticated Argo CD pulls. If it
is kept private, Argo CD needs a read-only GHCR repository credential with OCI
support enabled. Runtime image visibility is independent and may use the
cluster's existing image pull Secret.

Resource ordering within the Application is:

1. Secret, service accounts and network policy at sync wave `-3`.
2. PostgreSQL Service and StatefulSet at sync wave `-2`.
3. Idempotent migration `Sync` hook at wave `-1`.
4. Platform Deployment, Service and Ingress at wave `0`.

Platform upgrades use a Kubernetes-native blue/green equivalent: a
`RollingUpdate` Deployment creates a new ReplicaSet beside the live one,
requires two consecutive readiness successes plus `minReadySeconds`, and keeps
`maxUnavailable: 0`. The stable Service starts routing to the new Pod only
after it is Ready; Kubernetes removes and terminates the old Pod after the new
ReplicaSet is Available. Existing connections receive the platform's normal
pre-stop and SIGTERM drain budget.

Both Pods may serve independent requests during the brief overlap. That is safe
because `PLATFORM_LEADER_LOCK=1` uses the platform's PostgreSQL advisory-lock
coordinator: only one Pod runs singleton recovery, sweepers and reconcilers.
This is intentionally implemented with the built-in Deployment controller;
the cluster does not need Caddy, Argo Rollouts, or another rollout CRD.

If the candidate never becomes Ready, the Deployment times out without taking
the old ReplicaSet down. Roll back by restoring the previous OCI chart version
in the Argo CD source; the same readiness-gated rollout then moves traffic back
to the previous immutable image set.

PostgreSQL data is held by a retained `openebs-lvm-retain` PVC. Deleting the
StatefulSet or Argo Application does not delete the underlying volume. Take a
logical backup or VolumeSnapshot before database upgrades or data migration.

To inspect a published release without installing it:

```bash
helm pull oci://ghcr.io/adonagy-corp/charts/social-vibecoding-platform \
  --version 0.1.<release> --untar
helm template social-vibecoding-platform ./social-vibecoding-platform \
  -f ./social-vibecoding-platform/values.release.yaml \
  --set enabled=true \
  --set secrets.create=false \
  --set secrets.existingSecret=social-vibecoding
```
