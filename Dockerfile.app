FROM denoland/deno:2.9.7

COPY --from=mwader/static-ffmpeg:latest /ffprobe /usr/local/bin/

WORKDIR /app

# Copy everything
COPY . .

# Install workspace dependencies
RUN deno install

# Build frontend using Vite via Deno
WORKDIR /app/frontend
RUN deno run -A npm:vite build

# Go back to root
WORKDIR /app

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "--allow-env", "backend/main.ts"]
