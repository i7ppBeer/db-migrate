#!/usr/bin/env bash
# k8s/notification-html.sh — sourced, not run. Renders the standalone
# notification.html used when db-migrate itself never got to write one:
# pre-flight failures, bad profile/ConfigMap contents, a run that stopped
# before db-migrate started. Same visual language as reporter.js's
# notificationEmailToHTML — single style, inline styles, mail-client-safe.
#
# Used by preflight-check.sh and dynamic/submit.sh (outside the cluster) and
# by dynamic/run.sh (inside the Pod, shipped in the run's config ConfigMap).

# HTML-escape one string
_nh_escape() {
  local s=$1
  # Replacements quoted: since bash 5.2, an unquoted & in the replacement
  # means "the matched text" (patsub_replacement)
  s=${s//&/'&amp;'}; s=${s//</'&lt;'}; s=${s//>/'&gt;'}; s=${s//\"/'&quot;'}
  printf '%s' "$s"
}

# write_notification_html <out-dir> <error|waiting> <title> <detail> <label> <meta>
#   label: shown top-right (the project)   meta: the grey line under the header
# Writes <out-dir>/notification.html (mode 0600) and prints its path to stderr.
write_notification_html() {
  local out=$1 kind=$2 accent bg file title detail label meta
  title=$(_nh_escape "$3"); detail=$(_nh_escape "$4"); label=$(_nh_escape "$5"); meta=$(_nh_escape "$6")
  case "$kind" in
    waiting) accent="#1f7a8c"; bg="#dff1f3" ;;
    *)       accent="#b0303f"; bg="#fbe8ea" ;;
  esac
  mkdir -p "$out"
  file="$out/notification.html"
  ( umask 077; cat > "$file" ) <<EOF
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Migration Notification</title></head>
<body style="margin:0;padding:0;background:#eef1ee;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef1ee" style="background:#eef1ee;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d7ddd4;">
<tr><td bgcolor="#171b21" style="background:#171b21;padding:18px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-family:Arial,sans-serif;color:#ffffff;font-size:15px;font-weight:bold;">Migration Notification</td>
<td align="right" style="font-family:Arial,sans-serif;color:#c9cdc6;font-size:12px;">${label}</td>
</tr></table></td></tr>
<tr><td style="padding:20px 28px 4px;font-family:Arial,sans-serif;font-size:12px;color:#5b6259;">${meta}</td></tr>
<tr><td style="padding:18px 28px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${bg}" style="background:${bg};border-left:3px solid ${accent};padding:12px 14px;">
<span style="font-family:Arial,sans-serif;font-size:14px;color:#1c211d;font-weight:bold;">${title}</span><br>
<span style="font-family:Arial,sans-serif;font-size:12px;color:#3a3f38;">${detail}</span>
</td></tr></table></td></tr>
<tr><td style="padding:18px 28px 22px;border-top:1px solid #d7ddd4;font-family:Arial,sans-serif;font-size:11px;color:#8a8f86;">This is an automated migration notification. Do not reply.</td></tr>
</table></td></tr></table></body></html>
EOF
  echo "📧 Notification written to $file" >&2
}
