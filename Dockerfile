# One image, two processes: the worker (default) and the MCP server.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
USER node

# Node 24 runs the TypeScript sources directly (type stripping), so there is no build step.
CMD ["node", "src/worker/main.ts"]
