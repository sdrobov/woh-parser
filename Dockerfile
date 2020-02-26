FROM keymetrics/pm2:10-alpine

RUN apk add python2 build-base pkgconf pixman-dev cairo-dev pango-dev libjpeg-turbo-dev

RUN mkdir -p /app
WORKDIR /app
RUN touch ./.env

COPY index.js .
COPY package.json .
COPY package-lock.json .
COPY ecosystem.config.js .
COPY parser parser/

RUN npm ci

CMD ["pm2-runtime", "start", "ecosystem.config.js"]
