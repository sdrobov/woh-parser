FROM keymetrics/pm2:latest-stretch

COPY index.js .
COPY package.json .
COPY ecosystem.config.js .
COPY parser parser/

RUN yarn
RUN touch ./.env

CMD [ "pm2-runtime", "start", "ecosystem.config.js" ]
