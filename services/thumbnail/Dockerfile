FROM ubuntu:noble

ENV DEBIAN_FRONTEND=noninteractive
ENV NVIDIA_VISIBLE_DEVICES="all"
ENV NVIDIA_DRIVER_CAPABILITIES="compute,video,utility"

# Install Jellyfin's official optimized ffmpeg package and Python 3
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg ca-certificates python3 \
 && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/ubuntu noble main" \
    > /etc/apt/sources.list.d/jellyfin.list \
 && apt-get update && apt-get install -y --no-install-recommends \
    jellyfin-ffmpeg8 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py .

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["python3", "server.py"]
