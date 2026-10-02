#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>

// ==========================
// CHÂN ESP32
// ==========================

#define GAS_PIN       34
#define LDR_PIN       35
#define LED_PIN       4
#define BUZZER_PIN    2

// ==========================
// NGƯỠNG
// ==========================

// Gas > 35% -> báo động
#define GAS_PERCENT_ALARM 35.0

// Ánh sáng < 10 lux -> trời tối
#define NGUONG_ANH_SANG 10.0

// ==========================
// HIỆU CHUẨN GAS
// ==========================

// Mốc ADC thực tế bạn đã đo:
// Wokwi khoảng 0.1 ppm -> ADC 843
#define GAS_ADC_MIN 843.0
#define GAS_ADC_9000 3487.0

// ==========================
// WIFI
// ==========================

const char* ssid = "Wokwi-GUEST";
const char* password = "";

// ==========================
// MQTT
// ==========================

const char* mqtt_server = "broker.emqx.io";
const int mqtt_port = 1883;

const char* topic_sensor = "nhansida/iot/sensor";

WiFiClient espClient;
PubSubClient client(espClient);

// ==========================
// BUZZER
// ==========================

#define BUZZER_CHANNEL 0
#define BUZZER_FREQ 1000
#define BUZZER_RESOLUTION 8


// =====================================================
// WIFI
// =====================================================

void setup_wifi()
{
    Serial.println();
    Serial.println("Dang ket noi WiFi...");

    WiFi.begin(ssid, password);

    while (WiFi.status() != WL_CONNECTED)
    {
        delay(500);
        Serial.print(".");
    }

    Serial.println();
    Serial.println("WiFi da ket noi!");

    Serial.print("IP ESP32: ");
    Serial.println(WiFi.localIP());
}


// =====================================================
// MQTT
// =====================================================

void reconnectMQTT()
{
    while (!client.connected())
    {
        Serial.print("Dang ket noi MQTT...");

        String clientID =
            "ESP32_Wokwi_" +
            String(random(1000, 9999));

        if (client.connect(clientID.c_str()))
        {
            Serial.println("OK");
        }
        else
        {
            Serial.print("Loi MQTT, rc=");
            Serial.println(client.state());

            delay(2000);
        }
    }
}


// =====================================================
// ĐỌC GAS PERCENT
// =====================================================
//
// Quy ước:
//
// 0.1 ppm  -> 0%
// 9000 ppm -> 70%
//
// ADC 843  -> 0%
// ADC 2048 -> 70%
//
// =====================================================

float docGasPercent()
{
    int adc = analogRead(GAS_PIN);

    // ADC -> PPM
    float gasPPM;

    if (adc <= GAS_ADC_MIN)
        gasPPM = 0.1;
    else if (adc >= GAS_ADC_9000)
        gasPPM = 9000.0;
    else
        gasPPM = 0.1 +
                 ((float)(adc - GAS_ADC_MIN) /
                 (GAS_ADC_9000 - GAS_ADC_MIN)) *
                 (9000.0 - 0.1);

    // PPM -> %
    float gasPercent =
        ((gasPPM - 0.1) / (9000.0 - 0.1)) * 100.0;

    gasPercent = constrain(gasPercent, 0.0, 100.0);

    return gasPercent;
}


// =====================================================
// ƯỚC LƯỢNG PPM
// =====================================================
//
// 843 ADC  -> 0.1 ppm
// 2048 ADC -> 9000 ppm
//
// =====================================================

float docGasPPM()
{
    int adc = analogRead(GAS_PIN);

    float ppm;

    // -----------------------------------------
    // ADC <= 843
    // -----------------------------------------

    if (adc <= GAS_ADC_MIN)
    {
        ppm = 0.1;
    }

    // -----------------------------------------
    // ADC >= 2048
    // -----------------------------------------

    else if (adc >= GAS_ADC_9000)
    {
        ppm = 9000.0;
    }

    // -----------------------------------------
    // Nội suy tuyến tính
    // -----------------------------------------

    else
    {
        ppm =
            0.1 +
            ((adc - GAS_ADC_MIN) /
             (GAS_ADC_9000 - GAS_ADC_MIN))
            * (9000.0 - 0.1);
    }

    ppm =
        constrain(
            ppm,
            0.1,
            9000.0
        );

    return ppm;
}


// =====================================================
// ĐỌC ÁNH SÁNG
// =====================================================

float docAnhSang()
{
    int adc = analogRead(LDR_PIN);

    const float GAMMA = 0.7;
    const float RL10 = 50.0;

    float voltage =
        ((float)adc / 4095.0) * 5.0;

    if (voltage >= 4.99)
    {
        return 0.1;
    }

    if (voltage <= 0.001)
    {
        return 100000.0;
    }

    float resistance =
        2000.0 *
        voltage /
        (1.0 - voltage / 5.0);

    float lux =
        pow(
            RL10 *
            1000.0 *
            pow(10, GAMMA) /
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

void setup()
{
    Serial.begin(115200);

    delay(1000);

    // --------------------------
    // Cảm biến
    // --------------------------

    pinMode(GAS_PIN, INPUT);
    pinMode(LDR_PIN, INPUT);

    // --------------------------
    // LED
    // --------------------------

    pinMode(LED_PIN, OUTPUT);

    digitalWrite(
        LED_PIN,
        LOW
    );

    // --------------------------
    // Buzzer
    // --------------------------

    ledcSetup(
        BUZZER_CHANNEL,
        BUZZER_FREQ,
        BUZZER_RESOLUTION
    );

    ledcAttachPin(
        BUZZER_PIN,
        BUZZER_CHANNEL
    );

    ledcWriteTone(
        BUZZER_CHANNEL,
        0
    );

    // --------------------------
    // WiFi
    // --------------------------

    setup_wifi();

    // --------------------------
    // MQTT
    // --------------------------

    client.setServer(
        mqtt_server,
        mqtt_port
    );

    Serial.println();
    Serial.println("==============================");
    Serial.println("ESP32 SAN SANG!");
    Serial.println("==============================");
}


// =====================================================
// LOOP
// =====================================================

void loop()
{
    // --------------------------
    // MQTT
    // --------------------------

    if (!client.connected())
    {
        reconnectMQTT();
    }

    client.loop();


    // --------------------------
    // ĐỌC CẢM BIẾN
    // --------------------------

    int gasADC = analogRead(GAS_PIN);

    float gasPercent =
        docGasPercent();

    float gasPPM =
        docGasPPM();

    float light =
        docAnhSang();


    // =================================================
    // LED
    // =================================================

    if (light < NGUONG_ANH_SANG)
    {
        // Dưới 10 lux
        // Trời tối

        digitalWrite(
            LED_PIN,
            HIGH
        );
    }
    else
    {
        // Từ 10 lux trở lên
        // Trời sáng

        digitalWrite(
            LED_PIN,
            LOW
        );
    }


    // =================================================
    // BUZZER
    // =================================================
    //
    // Gas > 35% -> BUZZER ON
    // Gas <= 35% -> BUZZER OFF
    //
    // =================================================

    if (gasPercent > GAS_PERCENT_ALARM)
    {
        ledcWriteTone(
            BUZZER_CHANNEL,
            1000
        );
    }
    else
    {
        ledcWriteTone(
            BUZZER_CHANNEL,
            0
        );
    }


    // =================================================
    // JSON
    // =================================================

    String data =
        "{\"gas\":" +
        String(gasPercent, 1) +
        ",\"light\":" +
        String(light, 1) +
        "}";


    // =================================================
    // MQTT
    // =================================================

    client.publish(
        topic_sensor,
        data.c_str()
    );


    // =================================================
    // SERIAL
    // =================================================

    Serial.println();
    Serial.println("==============================");

    Serial.print("Gas ADC: ");
    Serial.println(gasADC);

    Serial.print("Gas PPM: ");
    Serial.print(
        gasPPM,
        1
    );
    Serial.println(" ppm");

    Serial.print("Gas Web: ");
    Serial.print(
        gasPercent,
        1
    );
    Serial.println(" %");

    Serial.print("Light: ");
    Serial.print(
        light,
        1
    );
    Serial.println(" lux");

    Serial.print("JSON: ");
    Serial.println(data);


    // =================================================
    // TRẠNG THÁI GAS
    // =================================================

    if (gasPercent > GAS_PERCENT_ALARM)
    {
        Serial.println(
            "!!! CANH BAO GAS > 35% - BUZZER ON !!!"
        );
    }
    else
    {
        Serial.println(
            "Gas <= 35% - BUZZER OFF"
        );
    }


    // =================================================
    // TRẠNG THÁI ÁNH SÁNG
    // =================================================

    if (light < NGUONG_ANH_SANG)
    {
        Serial.println(
            "Troi toi - LED ON"
        );
    }
    else
    {
        Serial.println(
            "Troi sang - LED OFF"
        );
    }


    // --------------------------
    // Đọc lại sau 1 giây
    // --------------------------

    delay(1000);
}