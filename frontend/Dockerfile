FROM denoland/deno:2.9.7

WORKDIR /app

# Copy workspace configuration
COPY deno.json deno.lock ./
COPY frontend/ ./frontend/
COPY backend/ ./backend/

# Install dependencies
RUN deno install

WORKDIR /app/frontend

EXPOSE 5173

CMD ["deno", "run", "--unstable-no-legacy-abort", "-A", "npm:vite", "--host"]
