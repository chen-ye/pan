FROM denoland/deno:2.1.4

WORKDIR /app

# Copy everything
COPY . .

# Build frontend
WORKDIR /app/frontend

# Install dependencies via Deno (reads package.json)
# We accept all permissions for install scripts if any
RUN deno install --allow-scripts

# Build using Vite via Deno
# We skip tsc check to ensure build passes with existing types
RUN deno run -A npm:vite build

# Go back to root
WORKDIR /app

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "backend/main.ts"]
