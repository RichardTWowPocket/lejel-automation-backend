#!/bin/bash

# Test all 5 profiles with FFmpeg directly
# No API, no axios, just pure FFmpeg testing

IMAGE="public/media/1769053993782-151271291.png"
HEADLINE="<h>서진시스템</h><br><h>정밀파운드리</h> 전환"
SUBTITLE="서진시스템, 정밀파운드리로 레벨업 중 놓치면 손해"
DURATION=5

PROFILES=("default" "saham_catatan" "saham_labs" "saham_logs" "saham_suhu")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎬 Testing All Profiles with FFmpeg"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for profile in "${PROFILES[@]}"; do
  echo "🧪 Testing profile: $profile"
  
  node scripts/run-ffmpeg-test.js "$profile" \
    --image="$IMAGE" \
    --headline="$HEADLINE" \
    --subtitle="$SUBTITLE" \
    --duration=$DURATION \
    --output="temp/test-${profile}.mp4"
  
  if [ $? -eq 0 ]; then
    echo "✅ $profile: SUCCESS"
  else
    echo "❌ $profile: FAILED"
  fi
  
  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Results:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ls -lh temp/test-*.mp4
echo ""
echo "💡 Open the videos to compare profile styling!"
