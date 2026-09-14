# AgentCore Runtime requires linux/arm64.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim

WORKDIR /app

# Install deps first so this layer caches between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY skills ./skills
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8080
# Force the Bedrock provider: the container has no Ollama and no Anthropic key,
# only the AgentCore task role.
ENV MODEL_PRESET=dev

EXPOSE 8080

CMD ["node", "server.js"]
