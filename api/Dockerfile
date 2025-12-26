FROM node:20-alpine

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev

COPY index.js /app/index.js

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "index.js"]