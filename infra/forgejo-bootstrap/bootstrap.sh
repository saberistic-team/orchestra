#!/bin/sh
set -eu

config=/var/lib/gitea/custom/conf/app.ini
work_path=/var/lib/gitea
username=${FORGEJO_ADMIN_USER:?FORGEJO_ADMIN_USER is required}
password=${FORGEJO_ADMIN_PASSWORD:?FORGEJO_ADMIN_PASSWORD is required}
email=${FORGEJO_ADMIN_EMAIL:?FORGEJO_ADMIN_EMAIL is required}
agent_password=${FORGEJO_AGENT_PASSWORD:-orchestra-local-agent-change-me}

list_usernames() {
  forgejo --work-path "$work_path" --config "$config" admin user list | awk 'NR > 1 { print $2 }'
}

ensure_user() {
  user=$1
  pass=$2
  mail=$3
  full_name=$4
  is_admin=${5:-false}

  if list_usernames | grep -Fxq "$user"; then
    echo "Forgejo user already exists: $user"
    return 0
  fi

  if [ "$is_admin" = "true" ]; then
    forgejo --work-path "$work_path" --config "$config" admin user create \
      --username "$user" \
      --password "$pass" \
      --email "$mail" \
      --fullname "$full_name" \
      --admin \
      --must-change-password=false
  else
    forgejo --work-path "$work_path" --config "$config" admin user create \
      --username "$user" \
      --password "$pass" \
      --email "$mail" \
      --fullname "$full_name" \
      --must-change-password=false
  fi
  echo "Forgejo user created: $user"
}

ensure_user "$username" "$password" "$email" "Orchestra Agent" true

# One local Forgejo identity per delivery agent so issue activity is attributable.
for role in \
  manager requirements product ux architecture data security \
  planner builder test reviewer gate deployment validation
do
  ensure_user \
    "orchestra-${role}" \
    "$agent_password" \
    "${role}@orchestra.local" \
    "Orchestra ${role}" \
    false
done

echo "Forgejo bootstrap complete."
