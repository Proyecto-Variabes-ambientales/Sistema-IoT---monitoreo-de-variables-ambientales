#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <SensirionI2cScd4x.h>
#include <HardwareSerial.h>
#include <time.h>
#include <sys/time.h>
#include <string.h>   // strstr, sscanf
#include <stdlib.h>   // getenv, setenv, unsetenv
#include <stdio.h>    // sscanf

/* ────────────────────────────────
   Identificador de la tarjeta (ruta en RTDB)
   ──────────────────────────────── */
const char* BOARD_ID = "esp32-1";

/* ────────────────────────────────
   Pines / Sensores
   ──────────────────────────────── */
#define SDA_PIN 21
#define SCL_PIN 22
HardwareSerial      pmSerial(2);     // UART2: RX=16, TX=17 (PMS5003/MPM10-AG)
SensirionI2cScd4x   scd4x;
const uint8_t       SCD_ADDR = 0x62; // I2C SCD40

/* ────────────────────────────────
   Wi-Fi (ajusta para las pruebas)
   ──────────────────────────────── */
const char* ssid = "#Proyecto-Sensor-UTS";
const char* pwd  = "Proyecto2023.S";

/* ────────────────────────────────
   Firebase RTDB
   ──────────────────────────────── */
const String fbBase =
  String("https://esp32-sensores-582d2-default-rtdb.firebaseio.com/data/")
  + BOARD_ID + "/historial/";

/* ────────────────────────────────
   Timers / Control
   ──────────────────────────────── */
const unsigned long INTERVALO = 300000;  // 5 min en ms
unsigned long tPrev = 0;
int failHttp  = 0;
int failSCD   = 0;

/* ────────────────────────────────
   HTTPS client
   ──────────────────────────────── */
static WiFiClientSecure tls;
static HTTPClient       http;

/* ────────────────────────────────
   Helpers JSON
   ──────────────────────────────── */
String numOrNull(float v, uint8_t dec = 2) {
  if (!isfinite(v)) return F("null");
  char buf[24];
  snprintf(buf, sizeof(buf), "%.*f", dec, v);
  return String(buf);
}
String intOrNull(long v) {
  if (v < 0) return F("null");
  return String(v);
}

/* ────────────────────────────────
   Wi-Fi (bloqueante hasta conectar)
   ──────────────────────────────── */
void waitWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Conectando Wi-Fi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pwd);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWi-Fi OK. IP: %s  RSSI:%d dBm  MAC:%s\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI(),
                WiFi.macAddress().c_str());
}

/* ===================================================================== */
/* =======================  LECTURA PM (ROBUSTA)  ====================== */
/* ===================================================================== */

int lastPM1  = -1, lastPM25 = -1, lastPM10 = -1;

bool leerPM123_robusta(int &pm1, int &pm25, int &pm10) {
  const uint16_t FRAME_LEN = 32;
  uint8_t frame[FRAME_LEN];

  while (pmSerial.available() > 200) pmSerial.read();

  unsigned long deadline = millis() + 3000;
  int state = 0;
  while (millis() < deadline) {
    int c = pmSerial.read();
    if (c < 0) continue;
    if (state == 0) {
      if (c == 0x42) { frame[0] = (uint8_t)c; state = 1; }
    } else if (state == 1) {
      if (c == 0x4D) { frame[1] = (uint8_t)c; state = 2; break; }
      else state = 0;
    }
  }
  if (state != 2) return false;

  size_t need = FRAME_LEN - 2;
  if (pmSerial.readBytes(frame + 2, need) != need) return false;

  uint16_t dataLen = (frame[2] << 8) | frame[3];
  if (dataLen != 28) return false;

  uint16_t sum = 0;
  for (int i = 0; i < FRAME_LEN - 2; ++i) sum += frame[i];
  uint16_t chk = (frame[30] << 8) | frame[31];
  if (sum != chk) return false;

  int pm1_cf1  = (frame[4]  << 8) | frame[5];
  int pm25_cf1 = (frame[6]  << 8) | frame[7];
  int pm10_cf1 = (frame[8]  << 8) | frame[9];

  int pm1_env  = (frame[10] << 8) | frame[11];
  int pm25_env = (frame[12] << 8) | frame[13];
  int pm10_env = (frame[14] << 8) | frame[15];

  bool envAllZero  = (pm1_env==0 && pm25_env==0 && pm10_env==0);
  bool cf1AllZero  = (pm1_cf1==0 && pm25_cf1==0 && pm10_cf1==0);

  if (!envAllZero) {
    pm1 = pm1_env; pm25 = pm25_env; pm10 = pm10_env;
  } else if (!cf1AllZero) {
    pm1 = pm1_cf1; pm25 = pm25_cf1; pm10 = pm10_cf1;
  } else {
    return false;
  }

  return true;
}

/* ===================================================================== */
/* =========================  LECTURA SCD40  =========================== */
/* ===================================================================== */

void scdReinit() {
  scd4x.stopPeriodicMeasurement();
  delay(200);
  scd4x.reinit();
  delay(1000);
  scd4x.startPeriodicMeasurement();
  Serial.println("SCD40 reinit + startPeriodicMeasurement");
}
void initSCD40() {
  scd4x.begin(Wire, SCD_ADDR);
  scdReinit();
}

bool scdDataReady() {
  bool ready = false;
  int16_t err = scd4x.getDataReadyStatus(ready);
  if (err != 0) return false;
  return ready;
}

bool readSCD40(float &temp, float &hum, uint16_t &co2ppm) {
  if (!scdDataReady()) return false;
  uint16_t co2; float t, h;
  int err = scd4x.readMeasurement(co2, t, h);
  if (err != 0 || co2 == 0 || co2 == 0xFFFF || !isfinite(t) || !isfinite(h)) {
    return false;
  }
  temp = t; hum = h; co2ppm = co2;
  return true;
}

/* ===================================================================== */
/* =======================  TIEMPO: SNTP + HTTP  ======================= */
/* ===================================================================== */

// Inicializa SNTP con varios servidores (si UDP/123 está abierto)
void syncTimeInit() {
  // Colombia: UTC-5 sin DST (POSIX: "COT5" = UTC-5)
  configTzTime("COT5",
               "pool.ntp.org",
               "time.google.com",
               "time.cloudflare.com");
}

// ¿El reloj ya es válido? (>= 2023-01-01)
bool timeIsValid() {
  time_t now = time(nullptr);
  return now >= 1672531200;
}

// ISO local "YYYY-MM-DDTHH:MM:SS"
bool getIsoLocal(char* out, size_t n) {
  if (!timeIsValid()) return false;
  time_t now = time(nullptr);
  struct tm tmL;
  localtime_r(&now, &tmL);
  strftime(out, n, "%Y-%m-%dT%H:%M:%S", &tmL);
  return true;
}

// Obtiene epoch desde cabecera HTTP Date (HTTPS 443)
time_t fetchTimeFromHttpDate() {
  WiFiClientSecure cli;
  cli.setInsecure(); // para producción: carga root CA y quita esto
  if (!cli.connect("clients3.google.com", 443)) return 0;

  cli.print("GET /generate_204 HTTP/1.1\r\n"
            "Host: clients3.google.com\r\n"
            "Connection: close\r\n\r\n");

  String line;
  time_t candidate = 0;
  while (cli.connected()) {
    line = cli.readStringUntil('\n');
    if (line == "\r") break; // fin de cabeceras
    if (line.startsWith("Date: ")) {
      String d = line.substring(6);
      d.trim();
      struct tm t = {};
      char wk[4], monS[4], tz[4];
      int day, year, hh, mm, ss;
      if (sscanf(d.c_str(), "%3s, %d %3s %d %d:%d:%d %3s",
                 wk, &day, monS, &year, &hh, &mm, &ss, tz) == 8) {
        const char* months = "JanFebMarAprMayJunJulAugSepOctNovDec";
        const char* p = strstr(months, monS);
        if (p) {
          t.tm_mday = day;
          t.tm_mon  = (p - months) / 3;
          t.tm_year = year - 1900;
          t.tm_hour = hh; t.tm_min = mm; t.tm_sec = ss;

          // Convertir UTC a epoch usando TZ temporal UTC0
          char* tzprev = getenv("TZ");
          setenv("TZ", "UTC0", 1); tzset();
          candidate = mktime(&t);
          if (tzprev) setenv("TZ", tzprev, 1); else unsetenv("TZ");
          tzset();
        }
      }
    }
  }
  return candidate;
}

// Si NTP no funciona, fija la hora mediante HTTPS Date
void ensureTimeByHttpIfNeeded() {
  if (timeIsValid()) return;
  time_t t = fetchTimeFromHttpDate();
  if (t > 0) {
    struct timeval now = { .tv_sec = t, .tv_usec = 0 };
    settimeofday(&now, nullptr);
    // *** ARREGLO CLAVE ***
    // Reaplica explícitamente la zona horaria de Colombia (UTC-5)
    configTzTime("COT5", "pool.ntp.org");
  }
}

/* ===================================================================== */
/* ==============================  SETUP  ============================== */
/* ===================================================================== */
void setup() {
  Serial.begin(115200);
  delay(500);

  // I2C SCD40
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  // UART2 para PMS/MPM10-AG
  pmSerial.begin(9600, SERIAL_8N1, 16, 17);
  pmSerial.setRxBufferSize(1024);
  pmSerial.setTimeout(1500);
  while (pmSerial.available()) pmSerial.read();
  delay(1500);

  waitWifi();

  // Sincronización de hora: NTP y plan B por HTTPS
  syncTimeInit();
  for (int i = 0; i < 20 && !timeIsValid(); ++i) { delay(500); }
  if (!timeIsValid()) {
    Serial.println("NTP no disponible, intentando por HTTPS Date…");
    ensureTimeByHttpIfNeeded();
  }
  if (timeIsValid()) {
    char tmp[25]; getIsoLocal(tmp, sizeof(tmp));
    Serial.printf("Reloj OK: %s\n", tmp);
  } else {
    Serial.println("Reloj NO válido aún (se reintenta en loop).");
  }

  initSCD40();

  // TLS: en prototipo sin verificación; en producción carga root CA.
  tls.setInsecure();
  http.setReuse(false);
  http.setConnectTimeout(15000);
}

/* ===================================================================== */
/* ===============================  LOOP  ============================== */
/* ===================================================================== */
void loop() {
  if (millis() - tPrev < INTERVALO) return;
  tPrev = millis();

  waitWifi();  // reconecta si hace falta

  /* ───── SCD40 ───── */
  float temp = NAN, hum = NAN;
  uint16_t co2 = 0;
  if (!readSCD40(temp, hum, co2)) {
    failSCD++;
    Serial.printf("SCD40 sin dato (fail=%d)\n", failSCD);
    if (failSCD >= 3) { scdReinit(); failSCD = 0; }
  } else {
    failSCD = 0;
  }

  /* ───── PM ───── */
  int pm1 = -1, pm25 = -1, pm10 = -1;
  if (!leerPM123_robusta(pm1, pm25, pm10)) {
    Serial.println("PM inválido; usando último valor");
    pm1  = lastPM1;  pm25 = lastPM25;  pm10 = lastPM10;
  } else {
    lastPM1 = pm1;  lastPM25 = pm25;  lastPM10 = pm10;
  }

  /* ───── Timestamp local (ISO) ───── */
  if (!timeIsValid()) {
    // Reintenta ajustar hora si aún no está válida
    ensureTimeByHttpIfNeeded();
  }
  char ts[25] = {0};
  if (!getIsoLocal(ts, sizeof(ts))) {
    Serial.println("Sin hora válida, omitiendo subida.");
    return;
  }

  /* ───── JSON ───── */
  String payload = String("{\"temp\":") + numOrNull(temp) +
                   ",\"hum\":"  + numOrNull(hum)  +
                   ",\"co2\":"  + intOrNull(co2)  +
                   ",\"pm1\":"  + intOrNull(pm1)   +
                   ",\"pm25\":" + intOrNull(pm25)  +
                   ",\"pm10\":" + intOrNull(pm10)  + "}";

  /* ───── PUT a Firebase (clave = timestamp ISO) ───── */
  String url = fbBase + ts + ".json";
  Serial.printf("[PUT] %s\nPayload: %s\n", url.c_str(), payload.c_str());

  http.begin(tls, url);
  http.addHeader("Content-Type", "application/json");
  int code = http.PUT(payload);
  String body = http.getString();
  http.end();

  Serial.printf("HTTP %d  RSSI:%d  Heap:%u\nBody: %s\n\n",
                code, WiFi.RSSI(), ESP.getFreeHeap(), body.c_str());

  if (code >= 200 && code < 300) {
    failHttp = 0;
  } else {
    failHttp++;
    if (failHttp >= 6) {
      Serial.println("Demasiados fallos seguidos → ESP.restart()");
      delay(1000);
      ESP.restart();
    }
  }
}
