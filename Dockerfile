FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY tsconfig.json ./
COPY app ./app
COPY brand ./brand
COPY pitch/index.html pitch/video.html pitch/headcount-pitch.pdf pitch/og.png pitch/demo.mp4 ./pitch/
COPY pitch/img ./pitch/img
COPY anchor/target/idl/headcount.json ./anchor/target/idl/headcount.json
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=4040 DATA_DIR=/data
EXPOSE 4040
CMD ["node", "--import", "tsx", "app/server.ts"]
