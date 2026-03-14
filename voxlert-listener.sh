#!/usr/bin/env bash
# voxlert-listener.sh — Lightweight HTTP listener that receives WAV audio
# from a remote voxlert instance and plays it locally via afplay.
#
# Usage:
#   ./voxlert-listener.sh [port]    (default: 7890)
#
# On the remote machine, set in ~/.voxlert/config.json:
#   "remote_playback_url": "http://<mac-ip-or-tailscale>:7890/play"

PORT="${1:-7890}"
TMPDIR="${TMPDIR:-/tmp}"

echo "voxlert-listener: listening on port $PORT"
echo "  Configure remote voxlert with:"
echo "    remote_playback_url: http://<this-machine>:$PORT/play"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

cleanup() {
  echo "Shutting down."
  exit 0
}
trap cleanup INT TERM

while true; do
  TMPFILE="$TMPDIR/voxlert-$(date +%s%N 2>/dev/null || date +%s).wav"

  # Use nc to accept one HTTP request, save the body, and respond 200
  {
    # Read request line and headers
    read -r REQUEST_LINE
    CONTENT_LENGTH=0
    while IFS= read -r HEADER; do
      HEADER="${HEADER%%$'\r'}"
      [ -z "$HEADER" ] && break
      case "$HEADER" in
        Content-Length:*|content-length:*)
          CONTENT_LENGTH="${HEADER#*: }"
          CONTENT_LENGTH="${CONTENT_LENGTH%%$'\r'}"
          ;;
      esac
    done

    # Read body
    if [ "$CONTENT_LENGTH" -gt 0 ] 2>/dev/null; then
      dd bs=1 count="$CONTENT_LENGTH" of="$TMPFILE" 2>/dev/null
    fi

    # Send response
    printf "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"
  } < <(nc -l "$PORT") | cat

  # Play the audio if we received a file
  if [ -f "$TMPFILE" ] && [ -s "$TMPFILE" ]; then
    afplay "$TMPFILE" 2>/dev/null &
    # Clean up after playback finishes
    PLAY_PID=$!
    (wait "$PLAY_PID" 2>/dev/null; rm -f "$TMPFILE") &
  else
    rm -f "$TMPFILE" 2>/dev/null
  fi
done
