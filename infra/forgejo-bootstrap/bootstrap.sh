#!/bin/sh
set -eu

config=/var/lib/gitea/custom/conf/app.ini
work_path=/var/lib/gitea
username=${FORGEJO_ADMIN_USER:?FORGEJO_ADMIN_USER is required}
password=${FORGEJO_ADMIN_PASSWORD:?FORGEJO_ADMIN_PASSWORD is required}
email=${FORGEJO_ADMIN_EMAIL:?FORGEJO_ADMIN_EMAIL is required}

if forgejo --work-path "$work_path" --config "$config" admin user list | awk 'NR > 1 { print $2 }' | grep -Fxq "$username"; then
  echo "Forgejo automation account already exists."
  exit 0
fi

forgejo --work-path "$work_path" --config "$config" admin user create \
  --username "$username" \
  --password "$password" \
  --email "$email" \
  --admin \
  --must-change-password=false

echo "Forgejo automation account created."
