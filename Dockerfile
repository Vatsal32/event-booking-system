# ---- build stage ----
FROM node:26-alpine AS build
WORKDIR /app

RUN apk add --no-cache wget
RUN wget -qO- https://get.pnpm.io/install.sh | env ENV="$HOME/.shrc" SHELL="$(which sh)" sh -

ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

# ---- runtime stage ----
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY ./ca.pem /app/ca.pem
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]