
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

// =====================================================
// CHAN ESP32-C5
// =====================================================

#define GAS_PIN       1
#define LDR_PIN       2
#define BUZZER_PIN    3
#define LED_PIN       4

// =====================================================
// NGUONG CANH BAO
// =====================================================

// Gas > 35% -> Buzzer ON
#define GAS_PERCENT_ALARM 35.0

// Lux < 300 -> LED ON
#define NGUONG_ANH_SANG 300.0

// =====================================================
// HIEU CHUAN GAS
// =====================================================

#define GAS_ADC_MIN  843.0
#define GAS_ADC_9000 3487.0

// =====================================================
// WIFI
// =====================================================

const char* ssid = "Bao2o05";
const char* password = "99999999";

// =====================================================
// MQTT
// =====================================================

const char* mqtt_server = "g10a898d.ala.us-east-1.emqxsl.com";
const int mqtt_port = 8883;

const char* mqtt_username = "BAOSmart4";
const char* mqtt_password = "Phamminhbao710";

// =====================================================
// MQTT TOPIC
// =====================================================

const char* topic_sensor =
    "nhansida/iot/sensor";

const char* topic_control =
    "nhansida/iot/control";

const char* topic_status =
    "nhansida/iot/status";

// =====================================================
// MQTT CLIENT
// =====================================================

WiFiClientSecure espClient;
PubSubClient client(espClient);

// =====================================================
// BIEN HE THONG
// =====================================================

unsigned long lastPublish = 0;
unsigned long lastStatusPublish = 0;
unsigned long lastWifiAttempt = 0;

const unsigned long PUBLISH_INTERVAL = 1000;
const unsigned long STATUS_INTERVAL = 2000;
const unsigned long WIFI_RETRY_INTERVAL = 5000;

String currentMode = "auto";

bool ledState = false;
bool buzzerState = false;

// Trang thai canh bao khan cap
bool emergencyState = false;

// Trang thai ket noi
bool hasReceivedControl = false;

// =====================================================
// DOC BOOLEAN TRONG JSON
// Tra ve true neu tim thay truong hop le
// =====================================================

bool readJsonBool(
    const char* json,
    const char* key,
    bool* value
) {
    char searchKey[40];

    snprintf(
        searchKey,
        sizeof(searchKey),
        "\"%s\"",
        key
    );

    const char* pos = strstr(json, searchKey);

    if (pos == nullptr) {
        return false;
    }

    pos = strchr(pos, ':');

    if (pos == nullptr) {
        return false;
    }

    pos++;

    while (
        *pos == ' ' ||
        *pos == '\t' ||
        *pos == '\n' ||
        *pos == '\r'
    ) {
        pos++;
    }

    if (strncmp(pos, "true", 4) == 0) {
        *value = true;
        return true;
    }

    if (strncmp(pos, "false", 5) == 0) {
        *value = false;
        return true;
    }

    return false;
}

// =====================================================
// DOC CHUOI MODE TRONG JSON
// =====================================================

bool readJsonString(
    const char* json,
    const char* key,
    char* output,
    size_t outputSize
) {
    if (
        json == nullptr ||
        key == nullptr ||
        output == nullptr ||
        outputSize == 0
    ) {
        return false;
    }

    char searchKey[40];

    snprintf(
        searchKey,
        sizeof(searchKey),
        "\"%s\"",
        key
    );

    const char* pos = strstr(json, searchKey);

    if (pos == nullptr) {
        return false;
    }

    pos = strchr(pos, ':');

    if (pos == nullptr) {
        return false;
    }

    pos++;

    while (
        *pos == ' ' ||
        *pos == '\t' ||
        *pos == '\n' ||
        *pos == '\r'
    ) {
        pos++;
    }

    if (*pos != '"') {
        return false;
    }

    pos++;

    const char* endQuote = strchr(pos, '"');

    if (endQuote == nullptr) {
        return false;
    }

    size_t length = endQuote - pos;

    if (length >= outputSize) {
        return false;
    }

    memcpy(output, pos, length);
    output[length] = '\0';

    return true;
}

// =====================================================
// CAP NHAT GPIO
// =====================================================

void applyOutputs() {
    // Khi canh bao khan cap bat:
    // LED va buzzer deu duoc yeu cau bat.
    if (emergencyState) {
        digitalWrite(LED_PIN, HIGH);
        digitalWrite(BUZZER_PIN, HIGH);
        return;
    }

    digitalWrite(
        LED_PIN,
        ledState ? HIGH : LOW
    );

    digitalWrite(
        BUZZER_PIN,
        buzzerState ? HIGH : LOW
    );
}

// =====================================================
// GUI TRANG THAI THIET BI LEN BACKEND
// =====================================================

void publishDeviceStatus() {
    if (!client.connected()) {
        return;
    }

    char statusJson[200];

    snprintf(
        statusJson,
        sizeof(statusJson),
        "{\"mode\":\"%s\",\"led\":%s,\"buzzer\":%s,\"emergency\":%s}",
        currentMode.c_str(),
        ledState ? "true" : "false",
        buzzerState ? "true" : "false",
        emergencyState ? "true" : "false"
    );

    bool ok = client.publish(
        topic_status,
        statusJson,
        true
    );

    Serial.print("Trang thai thiet bi: ");
    Serial.println(statusJson);

    if (!ok) {
        Serial.println(
            "Gui trang thai MQTT that bai"
        );
    } else {
        lastStatusPublish = millis();
    }
}

// =====================================================
// XU LY LENH MQTT
// =====================================================

void mqttCallback(
    char* topic,
    byte* payload,
    unsigned int length
) {
    if (strcmp(topic, topic_control) != 0) {
        return;
    }

    char message[256];

    if (length >= sizeof(message)) {
        Serial.println(
            "Lenh MQTT qua dai, bo qua"
        );
        return;
    }

    memcpy(message, payload, length);
    message[length] = '\0';

    Serial.println();
    Serial.println("================================");
    Serial.println("NHAN LENH TU DASHBOARD");
    Serial.print("Topic: ");
    Serial.println(topic);
    Serial.print("Payload: ");
    Serial.println(message);

    // -------------------------------------------------
    // 1. KIEM TRA LENH CANH BAO KHAN CAP
    // -------------------------------------------------

    bool requestedEmergency;

    if (
        readJsonBool(
            message,
            "emergency",
            &requestedEmergency
        )
    ) {
        emergencyState = requestedEmergency;
        hasReceivedControl = true;

        Serial.print("CANH BAO KHAN CAP: ");

        Serial.println(
            emergencyState ? "BAT" : "TAT"
        );

        // Cap nhat GPIO ngay lap tuc.
        applyOutputs();

        // Gui lai trang thai de dashboard cap nhat.
        publishDeviceStatus();

        Serial.println("================================");
        return;
    }

    // -------------------------------------------------
    // 2. DOC CHE DO AUTO / MANUAL
    // -------------------------------------------------

    char modeValue[20] = {0};

    if (
        !readJsonString(
            message,
            "mode",
            modeValue,
            sizeof(modeValue)
        )
    ) {
        Serial.println(
            "Lenh khong co mode hoac emergency hop le"
        );

        Serial.println("================================");
        return;
    }

    // -------------------------------------------------
    // 3. CHE DO AUTO
    // -------------------------------------------------

    if (strcmp(modeValue, "auto") == 0) {
        currentMode = "auto";
        hasReceivedControl = true;

        Serial.println(
            "Da chuyen sang CHE DO TU DONG"
        );

        // Khong tu tat emergency.
        // Trang thai khan cap chi thay doi
        // khi nhan lenh emergency true/false.
        applyOutputs();
        publishDeviceStatus();

        Serial.println("================================");
        return;
    }

    // -------------------------------------------------
    // 4. CHE DO MANUAL
    // -------------------------------------------------

    if (strcmp(modeValue, "manual") == 0) {
        bool requestedLed = false;
        bool requestedBuzzer = false;

        bool ledValid = readJsonBool(
            message,
            "led",
            &requestedLed
        );

        bool buzzerValid = readJsonBool(
            message,
            "buzzer",
            &requestedBuzzer
        );

        if (!ledValid || !buzzerValid) {
            Serial.println(
                "Lenh manual can led va buzzer true/false"
            );

            Serial.println("================================");
            return;
        }

        currentMode = "manual";

        ledState = requestedLed;
        buzzerState = requestedBuzzer;

        hasReceivedControl = true;

        applyOutputs();

        Serial.println(
            "Da chuyen sang CHE DO THU CONG"
        );

        Serial.print("LED: ");
        Serial.println(ledState ? "ON" : "OFF");

        Serial.print("BUZZER: ");
        Serial.println(
            buzzerState ? "ON" : "OFF"
        );

        publishDeviceStatus();

        Serial.println("================================");
        return;
    }

    Serial.println("Mode khong hop le");
    Serial.println("================================");
}

// =====================================================
// KET NOI WIFI
// =====================================================

void setup_wifi() {
    Serial.println();
    Serial.println("================================");
    Serial.println("ESP32-C5 KET NOI WIFI");
    Serial.println("================================");

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.begin(ssid, password);

    unsigned long startTime = millis();

    while (
        WiFi.status() != WL_CONNECTED &&
        millis() - startTime < 20000
    ) {
        delay(500);
        Serial.print(".");
    }

    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("WIFI DA KET NOI!");

        Serial.print("Dia chi IP: ");
        Serial.println(WiFi.localIP());

        Serial.print("RSSI: ");
        Serial.println(WiFi.RSSI());
    } else {
        Serial.println(
            "WIFI CHUA KET NOI - SE THU LAI"
        );
    }
}

// =====================================================
// KET NOI MQTT
// =====================================================

void reconnectMQTT() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    Serial.println();
    Serial.println("Dang ket noi MQTT...");

    String clientID =
        "ESP32C5_" +
        String(
            (uint32_t)ESP.getEfuseMac(),
            HEX
        );

    if (
        client.connect(
            clientID.c_str(),
            mqtt_username,
            mqtt_password
        )
    ) {
        Serial.println("MQTT DA KET NOI!");

        bool subscribed = client.subscribe(
            topic_control,
            1
        );

        if (subscribed) {
            Serial.print("Da subscribe topic: ");
            Serial.println(topic_control);
        } else {
            Serial.println(
                "Subscribe topic that bai"
            );
        }

        publishDeviceStatus();
    } else {
        Serial.print(
            "MQTT ket noi that bai. rc = "
        );

        Serial.println(client.state());
    }
}

// =====================================================
// DOC GAS %
// =====================================================

float docGasPercent() {
    int adc = analogRead(GAS_PIN);

    float gasPercent;

    if (adc <= GAS_ADC_MIN) {
        gasPercent = 0.0;
    } else if (adc >= GAS_ADC_9000) {
        gasPercent = 100.0;
    } else {
        gasPercent =
            (
                (float)(adc - GAS_ADC_MIN) /
                (GAS_ADC_9000 - GAS_ADC_MIN)
            ) * 100.0;
    }

    return constrain(
        gasPercent,
        0.0,
        100.0
    );
}

// =====================================================
// DOC GAS PPM
// =====================================================

float docGasPPM() {
    int adc = analogRead(GAS_PIN);

    float ppm;

    if (adc <= GAS_ADC_MIN) {
        ppm = 0.1;
    } else if (adc >= GAS_ADC_9000) {
        ppm = 9000.0;
    } else {
        ppm =
            0.1 +
            (
                (float)(adc - GAS_ADC_MIN) /
                (GAS_ADC_9000 - GAS_ADC_MIN)
            ) * (9000.0 - 0.1);
    }

    return constrain(
        ppm,
        0.1,
        9000.0
    );
}

// =====================================================
// DOC ANH SANG - LUX
// =====================================================

float docAnhSang() {
    int adc = analogRead(LDR_PIN);

    float voltage =
        ((float)adc / 4095.0) * 3.3;

    if (voltage >= 3.29) {
        return 0.1;
    }

    if (voltage <= 0.001) {
        return 100000.0;
    }

    const float GAMMA = 0.7;
    const float RL10 = 50.0;

    float resistance =
        2000.0 * voltage /
        (3.3 - voltage);

    float lux =
        pow(
            RL10 * 1000.0 *
            pow(10.0, GAMMA) /
            resistance,
            1.0 / GAMMA
        );

    return constrain(
        lux,
        0.1,
        100000.0
    );
}

// =====================================================
// SETUP
// =====================================================

void setup() {
    Serial.begin(115200);
    delay(1500);

    analogReadResolution(12);

    pinMode(GAS_PIN, INPUT);
    pinMode(LDR_PIN, INPUT);

    pinMode(LED_PIN, OUTPUT);
    pinMode(BUZZER_PIN, OUTPUT);

    currentMode = "auto";

    ledState = false;
    buzzerState = false;
    emergencyState = false;

    applyOutputs();

    client.setCallback(mqttCallback);
    client.setBufferSize(256);

    // TLS test: bo qua kiem tra chung chi.
    // Nen thay bang chung chi CA khi trien khai that.
    espClient.setInsecure();

    client.setServer(
        mqtt_server,
        mqtt_port
    );

    client.setKeepAlive(30);
    client.setSocketTimeout(10);

    setup_wifi();

    Serial.println();
    Serial.println("================================");
    Serial.println("ESP32-C5 SMART4 SAN SANG");
    Serial.println("Mode mac dinh: AUTO");
    Serial.println("Emergency mac dinh: OFF");
    Serial.println("================================");
}

// =====================================================
// LOOP
// =====================================================

void loop() {
    // -------------------------------------------------
    // 1. DUY TRI WIFI
    // -------------------------------------------------

    if (WiFi.status() != WL_CONNECTED) {
        if (
            millis() - lastWifiAttempt >=
            WIFI_RETRY_INTERVAL
        ) {
            lastWifiAttempt = millis();

            Serial.println(
                "WiFi mat ket noi - dang ket noi lai"
            );

            WiFi.disconnect();
            WiFi.begin(ssid, password);
        }

        delay(10);
        return;
    }

    // -------------------------------------------------
    // 2. DUY TRI MQTT
    // -------------------------------------------------

    if (!client.connected()) {
        static unsigned long lastMqttAttempt = 0;

        if (
            millis() - lastMqttAttempt >= 3000
        ) {
            lastMqttAttempt = millis();
            reconnectMQTT();
        }
    } else {
        client.loop();
    }

    // -------------------------------------------------
    // 3. DOC CAM BIEN VA GUI DU LIEU
    // -------------------------------------------------

    if (
        millis() - lastPublish <
        PUBLISH_INTERVAL
    ) {
        return;
    }

    lastPublish = millis();

    int gasADC = analogRead(GAS_PIN);
    int ldrADC = analogRead(LDR_PIN);

    float gasPercent = docGasPercent();
    float gasPPM = docGasPPM();
    float light = docAnhSang();

    // -------------------------------------------------
    // 4. DIEU KHIEN TU DONG
    // -------------------------------------------------

    if (currentMode == "auto") {
        ledState =
            (light < NGUONG_ANH_SANG);

        buzzerState =
            (gasPercent > GAS_PERCENT_ALARM);
    }

    // Emergency duoc uu tien trong applyOutputs().
    applyOutputs();

    // -------------------------------------------------
    // 5. TAO JSON CAM BIEN
    // -------------------------------------------------

    char sensorJson[128];

    snprintf(
        sensorJson,
        sizeof(sensorJson),
        "{\"gas\":%.1f,\"light\":%.1f}",
        gasPercent,
        light
    );

    // -------------------------------------------------
    // 6. GUI CAM BIEN QUA MQTT
    // -------------------------------------------------

    bool sensorSent = false;

    if (client.connected()) {
        sensorSent = client.publish(
            topic_sensor,
            sensorJson
        );
    }

    // -------------------------------------------------
    // 7. GUI TRANG THAI DINH KY
    // -------------------------------------------------

    if (
        client.connected() &&
        millis() - lastStatusPublish >=
        STATUS_INTERVAL
    ) {
        publishDeviceStatus();
    }

    // -------------------------------------------------
    // 8. SERIAL MONITOR
    // -------------------------------------------------

    Serial.println();
    Serial.println("================================");

    Serial.print("Gas ADC: ");
    Serial.println(gasADC);

    Serial.print("LDR ADC: ");
    Serial.println(ldrADC);

    Serial.print("Gas PPM: ");
    Serial.print(gasPPM, 1);
    Serial.println(" ppm");

    Serial.print("Gas Web: ");
    Serial.print(gasPercent, 1);
    Serial.println(" %");

    Serial.print("Light: ");
    Serial.print(light, 1);
    Serial.println(" lux");

    Serial.print("Mode: ");
    Serial.println(currentMode);

    Serial.print("LED: ");
    Serial.println(
        emergencyState || ledState
            ? "ON"
            : "OFF"
    );

    Serial.print("BUZZER: ");
    Serial.println(
        emergencyState || buzzerState
            ? "ON"
            : "OFF"
    );

    Serial.print("Emergency: ");
    Serial.println(
        emergencyState ? "ON" : "OFF"
    );

    Serial.print("JSON sensor: ");
    Serial.println(sensorJson);

    Serial.println(
        sensorSent
            ? "MQTT: GUI CAM BIEN THANH CONG"
            : "MQTT: CHUA GUI DUOC CAM BIEN"
    );

    Serial.println("================================");
}
