{{- define "social-vibecoding-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "social-vibecoding-platform.fullname" -}}
{{- default (printf "%s-%s" .Release.Name (include "social-vibecoding-platform.name" .)) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "social-vibecoding-platform.labels" -}}
app.kubernetes.io/name: {{ include "social-vibecoding-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: social-vibecoding
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "social-vibecoding-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "social-vibecoding-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "social-vibecoding-platform.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{- define "social-vibecoding-platform.secretName" -}}
{{- if .Values.secrets.create -}}
{{ include "social-vibecoding-platform.fullname" . }}
{{- else -}}
{{ required "secrets.existingSecret is required when secrets.create=false" .Values.secrets.existingSecret }}
{{- end -}}
{{- end -}}

{{- define "social-vibecoding-platform.image" -}}
{{- printf "%s@%s" .repository .digest -}}
{{- end -}}

{{- define "social-vibecoding-platform.postgresqlImage" -}}
{{- printf "%s:%s@%s" .repository .tag .digest -}}
{{- end -}}

{{- define "social-vibecoding-platform.validate" -}}
{{- if .Values.enabled -}}
  {{- if not (regexMatch "^[a-f0-9]{40}$" .Values.release.sourceRevision) -}}
    {{- fail "release.sourceRevision must be the full Git commit SHA when enabled=true" -}}
  {{- end -}}
  {{- range $name, $image := dict "platform.image" .Values.platform.image "platform.workerImage" .Values.platform.workerImage "platform.captureImage" .Values.platform.captureImage -}}
    {{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $image.digest) -}}
      {{- fail (printf "%s.digest must be an immutable sha256 digest when enabled=true" $name) -}}
    {{- end -}}
  {{- end -}}
  {{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .Values.postgresql.image.digest) -}}
    {{- fail "postgresql.image.digest must be an immutable sha256 digest" -}}
  {{- end -}}
  {{- if and .Values.secrets.create (not (regexMatch "^[A-Za-z0-9._~-]+$" .Values.secrets.databasePassword)) -}}
    {{- fail "secrets.databasePassword must be non-empty and URL-safe" -}}
  {{- end -}}
  {{- if or (empty .Values.config.publicHost) (empty .Values.config.generatedAppDomain) -}}
    {{- fail "config.publicHost and config.generatedAppDomain are required" -}}
  {{- end -}}
{{- end -}}
{{- end -}}
