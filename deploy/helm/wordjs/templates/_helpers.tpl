{{/* Expand the name of the chart. */}}
{{- define "wordjs.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name. */}}
{{- define "wordjs.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "wordjs.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "wordjs.labels" -}}
helm.sh/chart: {{ include "wordjs.chart" . }}
{{ include "wordjs.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "wordjs.selectorLabels" -}}
app.kubernetes.io/name: {{ include "wordjs.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
The public origin. Explicit siteUrl wins; otherwise derive it from the ingress host (https when that
host is covered by a TLS entry, http otherwise). Empty when neither is configured — the app then falls
back to its own default, which is only correct for a port-forwarded localhost test.
*/}}
{{- define "wordjs.siteUrl" -}}
{{- if .Values.siteUrl -}}
{{- .Values.siteUrl -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- $scheme := "http" -}}
{{- range .Values.ingress.tls -}}
{{- if and .hosts (has $.Values.ingress.host .hosts) -}}{{- $scheme = "https" -}}{{- end -}}
{{- end -}}
{{- printf "%s://%s" $scheme .Values.ingress.host -}}
{{- end -}}
{{- end }}

{{/*
Guard rails. This chart deploys ONE monolith pod against ReadWriteOnce volumes; rendering something the
chart cannot actually support is worse than refusing to render it.
*/}}
{{- define "wordjs.validate" -}}
{{- if gt (int .Values.replicaCount) 1 -}}
{{- fail "wordjs: replicaCount must be 1. This chart is monolith-only: the pod owns a ReadWriteOnce volume and, by default, an embedded SQLite database — a second replica would neither mount the volume nor share the database. Scaling out requires an external database plus the shared mounts described in documentation/multi-node.md, which this chart does not model." -}}
{{- end -}}
{{- if not .Values.image.repository -}}
{{- fail "wordjs: image.repository is required. No WordJS image is published to a public registry, so the chart ships no default that would resolve. Build the repository's root Dockerfile, push it, and set image.repository (and image.tag)." -}}
{{- end -}}
{{- end }}
