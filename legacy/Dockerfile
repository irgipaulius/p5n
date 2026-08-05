FROM python:3.12-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY src ./src

RUN pip install --no-cache-dir -e .

ENV P5N_DB=/data/p5n.sqlite
VOLUME ["/data"]

EXPOSE 8080
CMD ["p5n", "serve", "--host", "0.0.0.0", "--port", "8080", "--db", "/data/p5n.sqlite"]
