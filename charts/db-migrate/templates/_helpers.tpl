{{/*
Expand the name of the chart.
*/}}
{{- define "db-migrate.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "db-migrate.fullname" -}}
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

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "db-migrate.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "db-migrate.labels" -}}
helm.sh/chart: {{ include "db-migrate.chart" . }}
{{ include "db-migrate.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "db-migrate.selectorLabels" -}}
app.kubernetes.io/name: {{ include "db-migrate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "db-migrate.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "db-migrate.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
MongoDB connection URL
*/}}
{{- define "db-migrate.mongoUrl" -}}
{{- if .Values.mongodb.auth.enabled }}
{{- printf "mongodb://%s:%s@%s:%d/%s" .Values.mongodb.auth.username "$(MONGO_PASSWORD)" .Values.mongodb.host (int .Values.mongodb.port) .Values.mongodb.database }}
{{- else }}
{{- printf "mongodb://%s:%d/%s" .Values.mongodb.host (int .Values.mongodb.port) .Values.mongodb.database }}
{{- end }}
{{- if .Values.mongodb.options.replicaSet }}
{{- printf "?replicaSet=%s" .Values.mongodb.options.replicaSet }}
{{- end }}
{{- end }}

{{/*
MariaDB connection string
*/}}
{{- define "db-migrate.mariadbHost" -}}
{{- printf "%s:%d" .Values.mariadb.host (int .Values.mariadb.port) }}
{{- end }}

{{/*
Get database type
*/}}
{{- define "db-migrate.dbType" -}}
{{- if .Values.mongodb.enabled }}
{{- print "mongodb" }}
{{- else if .Values.mariadb.enabled }}
{{- print "mariadb" }}
{{- else }}
{{- .Values.dbType }}
{{- end }}
{{- end }}
