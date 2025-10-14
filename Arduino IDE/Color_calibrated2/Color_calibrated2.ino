// esp32_tcs34725_poster_debug.ino  (dual-band YELLOW + calibrated RED; GREEN unchanged)
// - Uses g/r, b/r and rfrac (r/(r+g+b))
// - Bands: GREEN, YELLOW₁ (high-ratio), YELLOW₂ (amber-ish), RED
// - Unknown only when too dark or off-band (then fallback to nearest centroid)

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_TCS34725.h>
#include <time.h>

// ===== USER CONFIG =====
const char* WIFI_SSID = "ADM_CSC_IP_2.4GHz";
const char* WIFI_PASS = "komataisen2024";

const char* SERVER_BASE   = "http://192.168.0.124:3001/api";
const char* EP_NOW        = "/ingest/now";
const char* EP_UPSERT     = "/ingest/upsert";
const char* MACHINE_CODE  = "CNC4";
const char* API_KEY       = "";   // optional

// Heartbeat (set 0 to disable)
#define HEARTBEAT_MS 15000

// TCS34725
#define TCS_INTEG  TCS34725_INTEGRATIONTIME_50MS
#define TCS_GAIN   TCS34725_GAIN_4X

// ---------- CALIBRATION ----------
// Brightness guard
const uint16_t CLEAR_MIN = 200;

// GREEN (your stable green cluster: g/r≈0.882, b/r≈0.895, rfrac≈0.36)
const float GR_GREEN_MIN = 0.875f;
const float BR_GREEN_MIN = 0.890f;

// YELLOW₁ (original “whitish yellow”: g/r≈0.796, b/r≈0.812, rfrac≈0.38)
const float GR_Y1_MIN = 0.760f, GR_Y1_MAX = 0.860f;
const float BR_Y1_MIN = 0.800f, BR_Y1_MAX = 0.870f;

// YELLOW₂ (new “amber” yellow: g/r≈0.414, b/r≈0.186, rfrac≈0.625)
const float GR_Y2_MIN = 0.330f, GR_Y2_MAX = 0.550f;
const float BR_Y2_MIN = 0.160f, BR_Y2_MAX = 0.300f;
const float RF_Y2_MIN = 0.550f, RF_Y2_MAX = 0.720f;

// RED (deep red you captured: g/r≈0.108, b/r≈0.149, rfrac≈0.79)
const float GR_RED_MAX    = 0.200f;  // g/r <= 0.20
const float BR_RED_MAX    = 0.300f;  // b/r <= 0.30
const float RFRAC_RED_MIN = 0.650f;  // rfrac >= 0.65

// Fallback centroids (also use rfrac lightly)
const float GR_C_GREEN=0.882f, BR_C_GREEN=0.895f, RF_C_GREEN=0.360f;
const float GR_C_Y1  =0.796f, BR_C_Y1  =0.812f, RF_C_Y1  =0.380f;
const float GR_C_Y2  =0.414f, BR_C_Y2  =0.186f, RF_C_Y2  =0.625f;
const float GR_C_RED =0.108f, BR_C_RED =0.149f, RF_C_RED =0.790f;
const float W_RFRAC  = 0.25f;  // weight for rfrac in fallback distance
// ---------------------------------

// Timing
const uint32_t SCAN_MS   = 50;
const uint32_t STABLE_MS = 200;
const bool SEND_ON_BOOT = true;
const bool RESEND_AT_MIDNIGHT = true;

// Timezone (Bangkok)
const long GMT_OFFSET_SEC = 7 * 3600;
const int  DST_OFFSET_SEC = 0;
const char* NTP_SERVER    = "pool.ntp.org";

// =======================

Adafruit_TCS34725 tcs;

enum Color { UNKNOWN=0, GREEN, YELLOW, RED };
static inline const char* cname(Color c){
  switch(c){ case GREEN:return "green"; case YELLOW:return "yellow"; case RED:return "red"; default:return "unknown"; }
}

static inline float sqr(float x){ return x*x; }

// Classify with explicit bands. Order matters: RED → GREEN → Y1 → Y2 → fallback.
static Color classify_rgb(uint16_t r,uint16_t g,uint16_t b,uint16_t C,
                          float& gr_out, float& br_out, float& rfrac_out){
  if (C < CLEAR_MIN || r == 0) { gr_out = br_out = rfrac_out = 0.0f; return UNKNOWN; }

  const float gr = (float)g / (float)r;          // g/r
  const float br = (float)b / (float)r;          // b/r
  const float sum = (float)r + (float)g + (float)b;
  const float rfrac = sum > 0.f ? ((float)r / sum) : 0.f;

  gr_out = gr; br_out = br; rfrac_out = rfrac;

  // --- RED ---
  if (gr <= GR_RED_MAX && br <= BR_RED_MAX && rfrac >= RFRAC_RED_MIN) return RED;

  // --- GREEN ---
  if (gr >= GR_GREEN_MIN && br >= BR_GREEN_MIN) return GREEN;

  // --- YELLOW₁ (high ratios) ---
  if (gr >= GR_Y1_MIN && gr <= GR_Y1_MAX &&
      br >= BR_Y1_MIN && br <= BR_Y1_MAX) return YELLOW;

  // --- YELLOW₂ (amber ratios + rfrac window) ---
  if (gr >= GR_Y2_MIN && gr <= GR_Y2_MAX &&
      br >= BR_Y2_MIN && br <= BR_Y2_MAX &&
      rfrac >= RF_Y2_MIN && rfrac <= RF_Y2_MAX) return YELLOW;

  // --- Fallback: nearest centroid in (gr, br, rfrac) ---
  const float dG = sqr(gr - GR_C_GREEN) + sqr(br - BR_C_GREEN) + W_RFRAC*sqr(rfrac - RF_C_GREEN);
  const float dY1= sqr(gr - GR_C_Y1  ) + sqr(br - BR_C_Y1  ) + W_RFRAC*sqr(rfrac - RF_C_Y1);
  const float dY2= sqr(gr - GR_C_Y2  ) + sqr(br - BR_C_Y2  ) + W_RFRAC*sqr(rfrac - RF_C_Y2);
  const float dR = sqr(gr - GR_C_RED ) + sqr(br - BR_C_RED ) + W_RFRAC*sqr(rfrac - RF_C_RED);

  float best=dG; Color out=GREEN;
  if (dY1 < best) { best=dY1; out=YELLOW; }
  if (dY2 < best) { best=dY2; out=YELLOW; }
  if (dR  < best) { best=dR;  out=RED;    }
  return out;
}

Color stableColor=UNKNOWN, candidateColor=UNKNOWN;
uint32_t candidateSince=0, lastScan=0, lastPrint=0, lastHeartbeat=0;
int lastYday=-1;

void connectWiFi(){
  if(WiFi.status()==WL_CONNECTED) return;
  Serial.printf("[WiFi] Connecting to %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0=millis();
  while(WiFi.status()!=WL_CONNECTED && millis()-t0<15000){ delay(300); Serial.print("."); }
  Serial.println();
  if(WiFi.status()==WL_CONNECTED){
    Serial.printf("[WiFi] Connected IP=%s RSSI=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.println("[WiFi] Connect FAILED (will retry in background)");
  }
}

bool httpPost(const char* path, const String& json){
  connectWiFi();
  if(WiFi.status()!=WL_CONNECTED){ Serial.println("[HTTP] skipped: WiFi not connected"); return false; }
  HTTPClient http;
  String url = String(SERVER_BASE)+String(path);
  http.begin(url);
  http.addHeader("Content-Type","application/json");
  if(strlen(API_KEY)>0) http.addHeader("X-API-Key", API_KEY);
  http.setTimeout(15000);

  Serial.printf("[POST] %s body=%s\n", url.c_str(), json.c_str());
  int code = http.POST(json);
  String resp = http.getString(); http.end();
  Serial.printf("[POST] HTTP %d resp=%s\n", code, resp.c_str());
  return (code>=200 && code<300);
}

bool postKnown(Color c){
  const String body = String("{\"machine_code\":\"")+MACHINE_CODE+"\",\"color\":\""+cname(c)+"\"}";
  return httpPost(EP_NOW, body);
}
bool postUnknown(){
  const String body = String("{\"machine_code\":\"")+MACHINE_CODE+"\",\"color\":\"unknown\"}";
  return httpPost(EP_NOW, body);
}
bool postHeartbeat(Color c){
  const String body = String("{\"machine_code\":\"")+MACHINE_CODE+"\",\"color\":\""+cname(c)+"\"}";
  return httpPost(EP_UPSERT, body);
}

void setup(){
  Serial.begin(115200);
  delay(300);
  Serial.println("\n[BOOT] ESP32 TCS34725 Poster (dual-band yellow + calibrated red)");
  Wire.begin(21,22);
  if(!tcs.begin()){
    Serial.println("! TCS34725 not found @0x29. Running heartbeat/HTTP only.");
  } else {
    tcs.setIntegrationTime(TCS_INTEG);
    tcs.setGain(TCS_GAIN);
  }

  connectWiFi();
  configTime(GMT_OFFSET_SEC, DST_OFFSET_SEC, NTP_SERVER);
  struct tm ti; if(getLocalTime(&ti,10000)) lastYday=ti.tm_yday;

  Serial.println("# ms, R,G,B,C, g/r, b/r, rfrac, color");

  // Seed initial state
  uint16_t r=0,g=0,b=0,c=0; tcs.getRawData(&r,&g,&b,&c);
  float gr=0, br=0, rfrac=0;
  candidateColor = stableColor = classify_rgb(r,g,b,c, gr, br, rfrac);
  candidateSince = millis();

  if(SEND_ON_BOOT){
    if(stableColor==UNKNOWN) postUnknown(); else postKnown(stableColor);
  }
}

void loop(){
  uint32_t now=millis();

  // Sensor scan
  if(now - lastScan >= SCAN_MS){
    lastScan = now;

    uint16_t r,g,b,c; tcs.getRawData(&r,&g,&b,&c);
    float gr=0, br=0, rfrac=0;
    Color rawCol = classify_rgb(r,g,b,c, gr, br, rfrac);

    if(now - lastPrint >= 500){
      lastPrint = now;
      Serial.printf("%lu,%u,%u,%u,%u,%.3f,%.3f,%.3f,%s\n",
        (unsigned long)now, r,g,b,c, gr, br, rfrac, cname(rawCol));
    }

    // Debounce -> commit change
    if(rawCol != candidateColor){
      candidateColor = rawCol;
      candidateSince = now;
    } else if((now - candidateSince) >= STABLE_MS && stableColor != candidateColor){
      stableColor = candidateColor;
      Serial.printf("[STATE] Color changed → %s\n", cname(stableColor));
      if(stableColor==UNKNOWN) postUnknown();
      else                     postKnown(stableColor);
      lastHeartbeat = now;
    }
  }

  // Heartbeat while color stays the same (and is known)
  #if HEARTBEAT_MS > 0
  if(stableColor!=UNKNOWN && (millis() - lastHeartbeat) >= HEARTBEAT_MS){
    lastHeartbeat = millis();
    postHeartbeat(stableColor);
  }
  #endif

  // New day -> re-post current state
  if(RESEND_AT_MIDNIGHT){
    struct tm ti; if(getLocalTime(&ti)){
      if(lastYday>=0 && ti.tm_yday!=lastYday){
        lastYday = ti.tm_yday;
        Serial.println("[STATE] Day changed → re-post current color");
        if(stableColor==UNKNOWN) postUnknown(); else postKnown(stableColor);
      }
    }
  }

  // WiFi background retry
  if(WiFi.status()!=WL_CONNECTED){
    static uint32_t lastRetry=0;
    if(now - lastRetry > 5000){ lastRetry = now; connectWiFi(); }
  }
}
