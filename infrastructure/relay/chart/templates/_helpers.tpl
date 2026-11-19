{{- define "relay.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "relay.labels" -}}
app.kubernetes.io/name: apilens-relay
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "relay.selector" -}}
app.kubernetes.io/name: apilens-relay
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "relay.secret" -}}
{{- default (include "relay.fullname" .) .Values.control.existingSecret -}}
{{- end -}}

{{- define "relay.pairs" -}}
{{- $pairs := list -}}
{{- range $name, $value := . -}}
{{- $pairs = append $pairs (printf "%s=%s" $name $value) -}}
{{- end -}}
{{- join "," $pairs -}}
{{- end -}}
