#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <math.h>

// =====================================================
// 1. WIFI
// =====================================================

// Dùng cho Wokwi.
// Nếu dùng Wi-Fi thật, thay bằng tên và mật khẩu Wi-Fi.
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";

// =====================================================
// 2. MQTT - EMQX CLOUD
// =====================================================

const char* MQTT_HOST = "g10a898d.ala.us-east-1.emqxsl.com";
const int MQTT_PORT = 8883;

// Điền thông tin MQTT MỚI sau khi đổi mật khẩu.
// Không dùng mật khẩu đã bị lộ trước đó.
const char* MQTT_USERNAME = "YOUR_NEW_MQTT_USERNAME";
const char* MQTT_PASSWORD = "YOUR_NEW_MQTT_PASSWORD";

const char* TOPIC_SENSOR = "nhansida/iot/sensor";
const char* TOPIC_CONTROL = "nhansida/iot/control";
const char* TOPIC_STATUS = "nhansida/iot/status";

// =====================================================
// 3. KHAI BÁO CHÂN
// =====================================================

// Các chân này được giữ từ code cũ.
// PHẢI kiểm tra và sửa theo sơ đồ chân ESP32-C5 thực tế.
#define GAS_PIN 34
#define LDR_PIN 35
#define LED_PIN 4
#define BUZZER_PIN 2
#define DHT_PIN 5

#define DHT_TYPE DHT22

// =====================================================
// 4. NGƯỠNG ĐIỀU KHIỂN
// =====================================================

// Gas vượt 35%: bật còi ở chế độ tự động.
const float GAS_THRESHOLD = 35.0;

// Ánh sáng dưới 300 lux: bật đèn ở chế độ tự động.
const float LIGHT_THRESHOLD = 300.0;

// =====================================================
// 5. ĐỐI TƯỢNG
// =====================================================

WiFiClientSecure secureClient;
PubSubClient mqttClient(secureClient);
DHT dht(DHT_PIN, DHT_TYPE);

// =====================================================
// 6. BIẾN TRẠNG THÁI
// =====================================================

bool autoMode = true;
bool manualLed = false;
bool manualBuzzer = false;

bool currentLed = false;
bool currentBuzzer = false;

unsigned long lastSensorPublish = 0;
unsigned long lastStatusPublish = 0;
unsigned long lastWifiAttempt = 0;

const unsigned long SENSOR_INTERVAL = 2000;
const unsigned long STATUS_INTERVAL = 2000;

// =====================================================
// 7. ĐỌC CẢM BIẾN
// =====================================================

// Đây là phép quy đổi tương đối theo ADC.
// Cần hiệu chuẩn theo cảm biến thực tế; không phải phép
// đo nồng độ gas ppm chính xác nếu chưa hiệu chuẩn.
float readGasPercent() {
    int raw = analogRead(GAS_PIN);

    float percent = (raw / 4095.0f) * 100.0f;

    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;

    return percent;
}

// Đọc ADC của cảm biến ánh sáng.
// Muốn đổi sang lux chính xác cần hiệu chuẩn LDR và mạch chia áp.
float readLightValue() {
    int raw = analogRead(LDR_PIN);

    // Giá trị ADC quy đổi tạm sang thang hiển thị 0-4095.
    // Đây KHÔNG phải lux thực.
    return (float)raw;
}

// =====================================================
// 8. WIFI
// =====================================================

void connectWiFi() {
    if (WiFi.status() == WL_CONNECTED) {
        return;
    }

    Serial.println("Dang ket noi Wi-Fi...");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long start = millis();

    while (WiFi.status() != WL_CONNECTED &&
           millis() - start < 15000) {
        delay(500);
        Serial.print(".");
    }

    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("WIFI: KET NOI THANH CONG");
        Serial.print("IP: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("WIFI: CHUA KET NOI");
    }
}

// =====================================================
// 9. GỬI TRẠNG THÁI THIẾT BỊ
// =====================================================

void publishStatus() {
    if (!mqttClient.connected()) {
        return;
    }

    char payload[160];

    snprintf(
        payload,
        sizeof(payload),
        "{\"mode\":\"%s\",\"led\":%s,\"buzzer\":%s}",
        autoMode ? "auto" : "manual",
        currentLed ? "true" : "false",
        currentBuzzer ? "true" : "false"
    );

    bool ok = mqttClient.publish(TOPIC_STATUS, payload);

    if (ok) {
        Serial.print("STATUS SENT: ");
        Serial.println(payload);
    }
}

// =====================================================
// 10. ÁP DỤNG ĐIỀU KHIỂN
// =====================================================

void applyOutputs() {
    if (autoMode) {
        float gas = readGasPercent();
        float light = readLightValue();

        // Tạm thời dùng giá trị ADC của LDR.
        // Chỉ đặt LIGHT_THRESHOLD = 300 nếu giá trị đọc
        // đã được hiệu chuẩn thành lux.
        currentLed = (light < LIGHT_THRESHOLD);
        currentBuzzer = (gas > GAS_THRESHOLD);
    } else {
        currentLed = manualLed;
        currentBuzzer = manualBuzzer;
    }

    digitalWrite(LED_PIN, currentLed ? HIGH : LOW);
    digitalWrite(BUZZER_PIN, currentBuzzer ? HIGH : LOW);
}

// =====================================================
// 11. NHẬN LỆNH TỪ WEBSITE QUA MQTT
// =====================================================

bool jsonBoolValue(const String& payload, const char* key, bool& value) {
    String searchKey = String("\"") + key + "\"";
    int keyPos = payload.indexOf(searchKey);

    if (keyPos < 0) {
        return false;
    }

    int colonPos = payload.indexOf(':', keyPos);

    if (colonPos < 0) {
        return false;
    }

    int truePos = payload.indexOf("true", colonPos);
    int falsePos = payload.indexOf("false", colonPos);

    if (truePos >= 0 && (falsePos < 0 || truePos < falsePos)) {
        value = true;
        return true;
    }

    if (falsePos >= 0) {
        value = false;
        return true;
    }

    return false;
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
    String topicName = String(topic);

    String message;
    message.reserve(length + 1);

    for (unsigned int i = 0; i < length; i++) {
        message += (char)payload[i];
    }

    Serial.print("MQTT RX [");
    Serial.print(topicName);
    Serial.print("]: ");
    Serial.println(message);

    if (topicName != TOPIC_CONTROL) {
        return;
    }

    if (message.indexOf("\"mode\":\"auto\"") >= 0) {
        autoMode = true;
        Serial.println("CHE DO: TU DONG");
    } else if (message.indexOf("\"mode\":\"manual\"") >= 0) {
        bool ledValue;
        bool buzzerValue;

        // Chỉ nhận lệnh manual nếu có đủ cả hai trạng thái.
        if (!jsonBoolValue(message, "led", ledValue) ||
            !jsonBoolValue(message, "buzzer", buzzerValue)) {
            Serial.println("CONTROL ERROR: THIEU LED/BUZZER");
            return;
        }

        autoMode = false;
        manualLed = ledValue;
        manualBuzzer = buzzerValue;

        Serial.println("CHE DO: THU CONG");
    } else {
        Serial.println("CONTROL ERROR: LENH KHONG HOP LE");
        return;
    }

    applyOutputs();
    publishStatus();
}

// =====================================================
// 12. KẾT NỐI MQTT
// =====================================================

void connectMQTT() {
    if (mqttClient.connected()) {
        return;
    }

    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    Serial.println("Dang ket noi MQTT...");

    String clientId = "Smart4_ESP32_";
    clientId += String((uint32_t)ESP.getEfuseMac(), HEX);

    if (mqttClient.connect(
            clientId.c_str(),
            MQTT_USERNAME,
            MQTT_PASSWORD)) {

        Serial.println("MQTT: KET NOI THANH CONG");

        if (mqttClient.subscribe(TOPIC_CONTROL)) {
            Serial.print("MQTT SUBSCRIBE: ");
            Serial.println(TOPIC_CONTROL);
        } else {
            Serial.println("MQTT SUBSCRIBE THAT BAI");
        }

        publishStatus();
    } else {
        Serial.print("MQTT LOI, rc = ");
        Serial.println(mqttClient.state());
    }
}

// =====================================================
// 13. GỬI DỮ LIỆU CẢM BIẾN
// =====================================================

void publishSensorData() {
    if (!mqttClient.connected()) {
        return;
    }

    float gas = readGasPercent();
    float light = readLightValue();

    float temperature = dht.readTemperature();
    float humidity = dht.readHumidity();

    char temperatureText[20];
    char humidityText[20];

    if (isnan(temperature)) {
        strcpy(temperatureText, "null");
    } else {
        snprintf(temperatureText, sizeof(temperatureText), "%.2f",
                 temperature);
    }

    if (isnan(humidity)) {
        strcpy(humidityText, "null");
    } else {
        snprintf(humidityText, sizeof(humidityText), "%.2f",
                 humidity);
    }

    char payload[240];

    snprintf(
        payload,
        sizeof(payload),
        "{\"gas\":%.2f,\"light\":%.2f,\"temperature\":%s,\"humidity\":%s}",
        gas,
        light,
        temperatureText,
        humidityText
    );

    if (mqttClient.publish(TOPIC_SENSOR, payload)) {
        Serial.print("SENSOR SENT: ");
        Serial.println(payload);
    } else {
        Serial.println("SENSOR PUBLISH THAT BAI");
    }
}

// =====================================================
// 14. SETUP
// =====================================================

void setup() {
    Serial.begin(115200);

    pinMode(LED_PIN, OUTPUT);
    pinMode(BUZZER_PIN, OUTPUT);

    digitalWrite(LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);

    analogReadResolution(12);

    dht.begin();

    // TLS được mã hóa nhưng tạm bỏ qua xác thực chứng chỉ.
    // Chỉ dùng để thử nghiệm; triển khai thực tế nên xác minh CA.
    secureClient.setInsecure();

    mqttClient.setServer(MQTT_HOST, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);
    mqttClient.setBufferSize(512);
    mqttClient.setKeepAlive(30);

    connectWiFi();
}

// =====================================================
// 15. LOOP
// =====================================================

void loop() {
    if (WiFi.status() != WL_CONNECTED) {
        if (millis() - lastWifiAttempt >= 5000) {
            lastWifiAttempt = millis();
            connectWiFi();
        }

        delay(10);
        return;
    }

    if (!mqttClient.connected()) {
        connectMQTT();
        delay(10);
        return;
    }

    mqttClient.loop();

    unsigned long now = millis();

    if (now - lastSensorPublish >= SENSOR_INTERVAL) {
        lastSensorPublish = now;

        applyOutputs();
        publishSensorData();
    }

    if (now - lastStatusPublish >= STATUS_INTERVAL) {
        lastStatusPublish = now;
        publishStatus();
    }

    delay(5);
}