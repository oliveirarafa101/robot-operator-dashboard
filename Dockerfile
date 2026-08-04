FROM node:22-alpine

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

ARG APP

RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @robot/shared build
RUN pnpm --filter @robot/${APP} build

ENV NODE_ENV=production
ENV APP=${APP}

CMD ["sh", "-c", "pnpm --filter @robot/${APP} start"]
