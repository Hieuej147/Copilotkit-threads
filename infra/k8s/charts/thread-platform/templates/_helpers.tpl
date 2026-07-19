{{- define "thread-platform.name" -}}thread-platform{{- end }}
{{- define "thread-platform.fullname" -}}{{ printf "%s-%s" .Release.Name (include "thread-platform.name" .) | trunc 63 | trimSuffix "-" }}{{- end }}
{{- define "thread-platform.labels" -}}
app.kubernetes.io/name: {{ include "thread-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "thread-platform.serviceAccountName" -}}{{ default (include "thread-platform.fullname" .) .Values.serviceAccount.name }}{{- end }}
{{- define "thread-platform.connectionsSecret" -}}
{{- if .Values.postgresql.enabled }}{{ include "thread-platform.fullname" . }}-connections{{ else }}{{ required "externalDatabase.existingSecret is required" .Values.externalDatabase.existingSecret }}{{ end }}
{{- end }}
{{- define "thread-platform.redisSecret" -}}
{{- if .Values.redis.enabled }}{{ include "thread-platform.fullname" . }}-connections{{ else }}{{ required "externalRedis.existingSecret is required" .Values.externalRedis.existingSecret }}{{ end }}
{{- end }}
{{- define "thread-platform.runtimeImage" -}}{{ printf "%s:%s" .Values.runtime.image.repository .Values.runtime.image.tag }}{{- end }}
{{- define "thread-platform.exampleAgentImage" -}}{{ printf "%s:%s" .Values.examples.agent.image.repository .Values.examples.agent.image.tag }}{{- end }}
{{- define "thread-platform.agentUrl" -}}
{{- if .Values.examples.enabled -}}
{{ printf "http://%s-agent:%v/agent" (include "thread-platform.fullname" .) .Values.examples.agent.port }}
{{- else -}}
{{ required "agent.url is required when examples.enabled=false" .Values.agent.url }}
{{- end -}}
{{- end }}
