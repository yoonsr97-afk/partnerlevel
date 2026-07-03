FROM node:20-slim

RUN apt-get update && apt-get install -y \
    libreoffice \
    fonts-nanum \
    fonts-nanum-extra \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 4000
CMD ["node", "server.js"]
