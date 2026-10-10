#!/bin/sh

# Exit immediately if a command exits with a non-zero status
set -e

# Split worker containers may skip migrations only after a migration job succeeds.
case "${RUN_MIGRATIONS-true}" in
    true)
        (cd /app/packages/backend && node dist/database/migrate.js)
        ;;
    false)
        ;;
    *)
        echo "RUN_MIGRATIONS must be true or false" >&2
        exit 1
        ;;
esac

export PORT="${PORT_FRONTEND:-3000}"

# Execute the main container command
exec "$@"
