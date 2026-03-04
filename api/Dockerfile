FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    certbot \
    python3-certbot-dns-google \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
