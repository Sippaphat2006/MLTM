// esp32_tcs34725_poster_debug.ino
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_TCS34725.h>
#include <time.h>

// ===== USER CONFIG =====
const char* WIFI_SSID = "ADM_CSC_IP_2.4GHz";
const char* WIFI_PASS = "komataisen2024";

const char* SERVER_BASE   = "http://192.168.11.186:3000/api";
const char* ENDPOINT_PATH = "/ingest/now";
const char* MACHINE_CODE  = "CNC4";
const char* API_KEY       = "";   // optional: X-API-Key

// TCS34725 sensor tuning
#define TCS_INTEG  TCS34725_INTEGRATIONTIME_50MS
#define TCS_GAIN   TCS34725_GAIN_4X
const uint16_t CLEAR_MIN = 80;
const float    SAT_MIN   = 0.15;
const float H_RED_MIN1=345.0, H_RED_MAX1=360.0, H_RED_MIN2=0.0, H_RED_MAX2=20.0;
const float H_YEL_MIN=25.0,  H_YEL_MAX=75.0,  H_GRN_MIN=90.0,  H_GRN_MAX=160.0;

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

Adafruit_TCS34725 tcs;  // default ctor

enum Color { UNKNOWN=0, GREEN, YELLOW, RED };
const char* cname(Color c){
  switch(c){ case GREEN:return "green"; case YELLOW:return "yellow"; case RED:return "red"; default:return "unknown"; }
}

static void rgb2hsv(float r,float g,float b,float& h,float& s,float& v){
  float mx=fmaxf(r,fmaxf(g,b)), mn=fminf(r,fminf(g,b)), d=mx-mn; v=mx; s=(mx==0.f)?0.f:(d/mx);
  if(d==0.f){ h=0.f; return; }
  if(mx==r)      h=60.f*fmodf(((g-b)/d),6.f);
  else if(mx==g) h=60.f*(((b-r)/d)+2.f);
  else           h=60.f*(((r-g)/d)+4.f);
  if(h<0.f) h+=360.f;
}

static Color classify(float h,float s,float v,uint16_t C){
  if(C < CLEAR_MIN) return UNKNOWN;
  if(s < SAT_MIN)   return UNKNOWN;
  if((h>=H_RED_MIN1 && h<=H_RED_MAX1) || (h>=H_RED_MIN2 && h<=H_RED_MAX2)) return RED;
  if(h>=H_YEL_MIN && h<=H_YEL_MAX) return YELLOW;
  if(h>=H_GRN_MIN && h<=H_GRN_MAX) return GREEN;
  return UNKNOWN;
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
  while(WiFi.status()!=WL_CONNECTED && millis()-t0<15000){
    delay(300); Serial.print(".");
  }
  Serial.println();
  if(WiFi.status()==WL_CONNECTED){
    Serial.printf("[WiFi] Connected IP=%s RSSI=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.println("[WiFi] Connect FAILED (will retry in background)");
  }
}

bool postColor(Color c){
  if(c==UNKNOWN) return false;
  connectWiFi();
  if(WiFi.status()!=WL_CONNECTED){ Serial.println("[POST] skipped: WiFi not connected"); return false; }

  HTTPClient http;
  String url = String(SERVER_BASE)+String(ENDPOINT_PATH);
  String body = String("{\"machine_code\":\"")+MACHINE_CODE+"\",\"color\":\""+cname(c)+"\"}";

  http.begin(url);
  http.addHeader("Content-Type","application/json");
  if(strlen(API_KEY)>0) http.addHeader("X-API-Key", API_KEY);

  Serial.printf("[POST] %s body=%s\n", url.c_str(), body.c_str());
  int code=http.POST(body);
  String resp=http.getString();
  http.end();
  Serial.printf("[POST] HTTP %d resp=%s\n", code, resp.c_str());
  return (code>=200 && code<300);
}

void setup(){
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[BOOT] ESP32 TCS34725 Poster (debug)");
  Serial.flush();

  Wire.begin(21,22); // SDA,SCL
  if(!tcs.begin()){
    Serial.println("! TCS34725 not found @0x29. Check wiring. Will keep printing heartbeat.");
    // keep running; don't while(1)
  } else {
    tcs.setIntegrationTime(TCS_INTEG);
    tcs.setGain(TCS_GAIN);
  }

  connectWiFi();
  configTime(GMT_OFFSET_SEC, DST_OFFSET_SEC, NTP_SERVER);
  struct tm ti; if(getLocalTime(&ti,10000)) lastYday=ti.tm_yday;

  // Print header so you always see something
  Serial.println("# ms,hue,sat,val,R,G,B,C,rf,gf,bf,color");
  Serial.flush();

  // Seed initial state
  uint16_t r=0,g=0,b=0,c=0; tcs.getRawData(&r,&g,&b,&c);
  float rf=c? (float)r/c:0, gf=c? (float)g/c:0, bf=c? (float)b/c:0;
  float h,s,v; rgb2hsv(rf,gf,bf,h,s,v);
  candidateColor = stableColor = classify(h,s,v,c);
  candidateSince = millis();

  if(SEND_ON_BOOT && stableColor!=UNKNOWN) postColor(stableColor);
}

void loop(){
  uint32_t now=millis();

  // Heartbeat every 1s so Serial is never "silent"
  if(now - lastHeartbeat >= 1000){
    lastHeartbeat = now;
    Serial.printf("[HB] ms=%lu wifi=%d color=%s heap=%u\n",
      (unsigned long)now, (int)WiFi.status(), cname(stableColor), (unsigned)ESP.getFreeHeap());
  }

  // Sensor scan
  if(now - lastScan >= SCAN_MS){
    lastScan = now;

    uint16_t r,g,b,c; tcs.getRawData(&r,&g,&b,&c);
    float rf=c? (float)r/c:0, gf=c? (float)g/c:0, bf=c? (float)b/c:0;
    float h,s,v; rgb2hsv(rf,gf,bf,h,s,v);
    Color rawCol = classify(h,s,v,c);

    // Print sensor line every ~500ms
    if(now - lastPrint >= 500){
      lastPrint = now;
      Serial.printf("%lu,%.1f,%.3f,%.3f,%u,%u,%u,%u,%.3f,%.3f,%.3f,%s\n",
        (unsigned long)now, h,s,v, r,g,b,c, rf,gf,bf, cname(rawCol));
    }

    // Debounce -> commit change
    if(rawCol != candidateColor){
      candidateColor = rawCol;
      candidateSince = now;
    } else if((now - candidateSince) >= STABLE_MS && stableColor != candidateColor){
      stableColor = candidateColor;
      Serial.printf("[STATE] Color changed → %s\n", cname(stableColor));
      if(stableColor != UNKNOWN) postColor(stableColor);
    }
  }

  // New day -> re-post to start new interval
  if(RESEND_AT_MIDNIGHT){
    struct tm ti; if(getLocalTime(&ti)){
      if(lastYday>=0 && ti.tm_yday!=lastYday){
        lastYday = ti.tm_yday;
        Serial.println("[STATE] Day changed → re-post current color");
        if(stableColor!=UNKNOWN) postColor(stableColor);
      }
    }
  }

  // WiFi background retry
  if(WiFi.status()!=WL_CONNECTED){
    static uint32_t lastRetry=0;
    if(now - lastRetry > 5000){ lastRetry = now; connectWiFi(); }
  }
}
