// esp32_tcs34725_poster_debug.ino  (calibrated 3-band with nearest-centroid fallback)
// - Board LED is OFF
// - Uses g/r and b/r; tight bands from your logs + centroid fallback

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_TCS34725.h>
#include <time.h>

// ===== USER CONFIG =====
const char* WIFI_SSID = "ADM_CSC_IP_2.4GHz";
const char* WIFI_PASS = "komataisen2024";

const char* SERVER_BASE   = "http://192.168.0.145:3000/api";
const char* EP_NOW        = "/ingest/now";
const char* EP_UPSERT     = "/ingest/upsert";
const char* MACHINE_CODE  = "CNC1";
const char* API_KEY       = "";   // optional

// Heartbeat (set 0 to disable)
#define HEARTBEAT_MS 10000

// TCS34725
#define TCS_INTEG  TCS34725_INTEGRATIONTIME_50MS
#define TCS_GAIN   TCS34725_GAIN_4X

// ---------- CALIBRATION (from your latest logs) ----------
// Brightness guard (reject darkness/stray light)
const uint16_t CLEAR_MIN = 200;

// GREEN band (from green samples: gr≈0.881–0.883, br≈0.893–0.896)
const float GR_GREEN_MIN = 0.875f;   // g/r >= 0.875
const float BR_GREEN_MIN = 0.890f;   // b/r >= 0.890

// YELLOW band (from yellow samples: gr≈0.795–0.797, br≈0.811–0.812)
const float GR_YEL_MAX   = 0.820f;   // g/r <= 0.820
const float BR_YEL_MAX   = 0.835f;   // b/r <= 0.835

// RED band (from “red” samples: gr≈0.838–0.840, br≈0.867–0.868)
const float GR_RED_MIN   = 0.830f;   // 0.830 ≤ g/r ≤ 0.860
const float GR_RED_MAX   = 0.860f;
const float BR_RED_MIN   = 0.860f;   // 0.860 ≤ b/r ≤ 0.880
const float BR_RED_MAX   = 0.880f;

// Centroids (for fallback when between bands)
const float GR_C_GREEN = 0.882f, BR_C_GREEN = 0.895f;
const float GR_C_YEL   = 0.796f, BR_C_YEL   = 0.812f;
const float GR_C_RED   = 0.839f, BR_C_RED   = 0.868f;
// --------------------------------------------------------

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

// Classify using tight bands; if no band matches, pick nearest centroid in (gr,br)
static Color classify_rgb(uint16_t r,uint16_t g,uint16_t b,uint16_t C, float& gr_out, float& br_out){
  if (C < CLEAR_MIN || r == 0) { gr_out = br_out = 0.0f; return UNKNOWN; }

  float gr = (float)g / (float)r;   // g/r
  float br = (float)b / (float)r;   // b/r
  gr_out = gr; br_out = br;

  // GREEN band
  if (gr >= GR_GREEN_MIN && br >= BR_GREEN_MIN) return GREEN;

  // YELLOW band
  if (gr <= GR_YEL_MAX && br <= BR_YEL_MAX) return YELLOW;

  // RED band
  if (gr >= GR_RED_MIN && gr <= GR_RED_MAX &&
      br >= BR_RED_MIN && br <= BR_RED_MAX) return RED;

  // Fallback: nearest centroid (ensures stable color when between bands)
  float dG = sqr(gr - GR_C_GREEN) + sqr(br - BR_C_GREEN);
  float dY = sqr(gr - GR_C_YEL)   + sqr(br - BR_C_YEL);
  float dR = sqr(gr - GR_C_RED)   + sqr(br - BR_C_RED);
  if (dG <= dY && dG <= dR) return GREEN;
  if (dY <= dG && dY <= dR) return YELLOW;
  return RED;
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
  Serial.println("\n[BOOT] ESP32 TCS34725 Poster (calibrated bands + centroid fallback)");
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

  Serial.println("# ms, R,G,B,C, g/r, b/r, color");

  // Seed initial state
  uint16_t r=0,g=0,b=0,c=0; tcs.getRawData(&r,&g,&b,&c);
  float gr=0, br=0;
  candidateColor = stableColor = classify_rgb(r,g,b,c, gr, br);
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
    float gr=0, br=0;
    Color rawCol = classify_rgb(r,g,b,c, gr, br);

    if(now - lastPrint >= 500){
      lastPrint = now;
      Serial.printf("%lu,%u,%u,%u,%u,%.3f,%.3f,%s\n",
        (unsigned long)now, r,g,b,c, gr, br, cname(rawCol));
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
