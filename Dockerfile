FROM oven/bun:latest

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json .

# Install dependencies
RUN bun install

# Copy source code
COPY server.ts .

# Expose port
EXPOSE 3001

# Run as bun user
USER bun

# Start the server directly (no entrypoint script needed for this simple app)
CMD ["bun", "run", "server.ts"]
