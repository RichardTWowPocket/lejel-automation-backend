FROM node:20-bullseye

# Install FFmpeg, fontconfig, and Noto fonts (CJK for Korean, Color Emoji)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fontconfig \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code and assets (including local fonts in public/)
COPY . .

# Create directory for custom fonts and copy them
RUN mkdir -p /usr/share/fonts/truetype/custom
# Copy all fonts from public recursively (assuming they are in subdirectories)
COPY public/ /usr/share/fonts/truetype/custom/

# Refresh font cache
RUN fc-cache -f -v

# Build the application
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
