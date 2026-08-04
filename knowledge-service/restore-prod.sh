#!/usr/bin/env bash
# ============================================================================
# restore-prod.sh — Restaura los datos de producción en el Postgres local.
#
# Requisitos:
#   - Postgres local corriendo en 127.0.0.1:5432 (usuario postgres / password postgres)
#   - La extensión pgvector ("vector") instalada en el server local.
#     Si no está instalada, el script se detiene y muestra cómo instalarla.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
export PGPASSWORD=postgres
export PGHOST PGPORT PGUSER

# ─── Localizar psql (PATH o el bundle descargado en pg-local/) ─────────────
PSQL=""
for c in psql pg-local/root/usr/lib/postgresql/18/bin/psql; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then PSQL="$c"; break; fi
done
[ -n "$PSQL" ] || { echo "✗ No encuentro psql (instala postgresql-client o usa el bundle pg-local/)"; exit 1; }

case "$PSQL" in
  pg-local/*) export LD_LIBRARY_PATH="$PWD/pg-local/root/usr/lib/x86_64-linux-gnu:$PWD/pg-local/root/usr/lib/postgresql/18/lib" ;;
esac
echo "Usando psql: $PSQL"

# ─── 1. Verificar pgvector ──────────────────────────────────────────────────
echo "1) Verificando extensión 'vector'..."
if ! "$PSQL" -d postgres -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" | grep -q 1; then
  echo "✗ pgvector NO está instalado en tu Postgres local."
  echo
  echo "   Instálalo según cómo tengas Postgres:"
  echo
  echo "   Opción A — Postgres instalado con apt/dpkg:"
  echo "     cd pg-local && sudo dpkg -i postgresql-16-pgvector_0.8.6-1.pgdg11+1_amd64.deb"
  echo
  echo "   Opción B — Postgres en contenedor Docker:"
  echo "     CT=<nombre-del-contenedor>  # ej: docker ps para verlo"
  echo "     docker cp pg-local/pgv16/usr/share/postgresql/16/extension/. \$CT:/usr/share/postgresql/16/extension/"
  echo "     docker cp pg-local/pgv16/usr/lib/postgresql/16/lib/vector.so \$CT:/usr/lib/postgresql/16/lib/"
  echo "     docker exec \$CT chown -R root:root /usr/share/postgresql/16/extension /usr/lib/postgresql/16/lib"
  echo
  echo "   Después de instalarlo, vuelve a ejecutar este script."
  exit 1
fi
echo "✓ pgvector disponible"

# ─── 2. Crear la base de datos si no existe ─────────────────────────────────
echo "2) Creando base de datos 'knowledge_db'..."
if ! "$PSQL" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='knowledge_db'" | grep -q 1; then
  "$PSQL" -d postgres -c "CREATE DATABASE knowledge_db"
  echo "✓ knowledge_db creada"
else
  echo "✓ knowledge_db ya existía"
fi

# ─── 3. Restaurar el dump ───────────────────────────────────────────────────
echo "3) Restaurando ../backend/db/prod-dump-pg16.sql ..."
"$PSQL" -d knowledge_db -f ../backend/db/prod-dump-pg16.sql
echo "✓ Dump restaurado"

# ─── 4. Verificación ────────────────────────────────────────────────────────
echo "4) Verificación:"
"$PSQL" -d knowledge_db -tAc \
  "SELECT 'sources    = ' || count(*) FROM knowledge_sources
   UNION ALL SELECT 'documents  = ' || count(*) FROM knowledge_documents
   UNION ALL SELECT 'chunks     = ' || count(*) FROM knowledge_chunks
   UNION ALL SELECT 'embeddings = ' || count(*) FROM knowledge_embeddings
   UNION ALL SELECT 'bots       = ' || count(*) FROM bots
   UNION ALL SELECT 'settings   = ' || count(*) FROM bot_settings
   UNION ALL SELECT 'conversations = ' || count(*) FROM conversations"

echo "✅ Restauración completada. La DB local está en: postgresql://postgres:postgres@localhost:5432/knowledge_db"
