FROM oven/bun:latest

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json .

# Install dependencies (no additional packages needed since bun includes everything)
RUN bun install

# Copy source code
COPY server.ts .

# Copy entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose port
EXPOSE 3001

# Run as bun user
USER bun

# Start the server
ENTRYPOINT [\"/usr/local/bin/entrypoint.sh\"]
CMD [\"bun\", \"run\", \"server.ts\"]
