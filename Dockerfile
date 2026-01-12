# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci || npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

# Install FFmpeg and Korean fonts for subtitle rendering
RUN apk add --no-cache ffmpeg fontconfig \
    && apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community \
    ttf-dejavu ttf-liberation ttf-opensans \
    && apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/edge/main \
    font-noto-cjk font-noto-emoji \
    && fc-cache -fv

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --production && npm cache clean --force

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Create temp directory for file uploads
RUN mkdir -p ./temp

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "dist/main.js"]

