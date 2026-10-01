FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY extension/*.mjs ./extension/
COPY server/*.mjs ./server/
RUN mkdir /data && chown pwuser:pwuser /data
USER pwuser
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node","server/index.mjs"]
