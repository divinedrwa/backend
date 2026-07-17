#!/usr/bin/env bash
# Shared live production targets (Render API).
LIVE_API_ORIGIN="${LIVE_API_ORIGIN:-https://gatepass-v037.onrender.com}"
LIVE_API_BASE="${LIVE_API_ORIGIN}/api"
export HTTP_SMOKE_BASE="${HTTP_SMOKE_BASE:-$LIVE_API_ORIGIN}"
export MOBILE_SMOKE_BASE="${MOBILE_SMOKE_BASE:-$LIVE_API_ORIGIN}"
export LIVE_API_ORIGIN LIVE_API_BASE
