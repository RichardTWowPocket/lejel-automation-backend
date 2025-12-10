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

