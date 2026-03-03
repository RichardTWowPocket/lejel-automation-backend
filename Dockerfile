FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine

# ffmpeg + ffprobe for video; fontconfig + fonts so ASS subtitles/headlines render (libass needs them)
RUN apk add --no-cache ffmpeg fontconfig \
  && (VER=$(cat /etc/alpine-release 2>/dev/null | cut -d. -f1,2) || VER=3.19; echo "http://dl-cdn.alpinelinux.org/alpine/v${VER}/community" >> /etc/apk/repositories && apk update && apk add --no-cache font-noto-cjk || true)

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Fonts for ASS overlay (headline + subtitle). libass resolves font names via fontconfig.
COPY public ./public
RUN mkdir -p /usr/share/fonts/custom \
  && for d in Black_Han_Sans hakgyoansim-jiugae Gasoek_One baekmuk; do \
       [ -d "/app/public/$d" ] && cp -r "/app/public/$d" /usr/share/fonts/custom/; \
     done \
  && fc-cache -fv

EXPOSE 3000

CMD ["node", "dist/main.js"]
