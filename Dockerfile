FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# همه dependency ها رو نصب کن (شامل devDependencies برای build)
RUN npm ci

COPY . .

# build
RUN npm run build

# بعد از build، devDependencies رو پاک کن
RUN npm prune --production

EXPOSE 3000

CMD ["npm", "start"]
