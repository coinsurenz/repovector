# repo-vector query API: `docker compose up` beside pgvector, or run against Pinecone.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production REPO_VECTOR_IN_DOCKER=true
WORKDIR /app
# The bundle carries every dependency; only the WASM assets travel beside it.
COPY --from=build /src/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REPO_VECTOR_SERVER_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
