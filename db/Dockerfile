FROM pgvector/pgvector:pg16

# Ensure pgvector extension files are installed
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*
