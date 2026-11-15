FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node ops-board ./ops-board
COPY --chown=node:node ops-status ./ops-status
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "ops-board/server.mjs"]
