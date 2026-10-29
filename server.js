"use strict";

require("dotenv").config();

const express = require("express");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ==================================================
// 1. CAU HINH SMART4 - EMQX
// ==================================================

const MQTT_HOST = process.env.EMQX_HOST;
const MQTT_PORT = Number(process.env.EMQX_PORT) || 8883;
const MQTT_USERNAME = process.env.EMQX_USERNAME;
const MQTT_PASSWORD = process.env.EMQX_PASSWORD;

const TOPIC_SENSOR = "nhansida/iot/sensor";
const TOPIC_CONTROL = "nhansida/iot/control";
const TOPIC_STATUS = "nhansida/iot/status";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const SAVE_INTERVAL_MS = 1000;

// ==================================================
// 2. KIEM TRA BIEN MOI TRUONG
// ==================================================

const requiredEnv = [
    "EMQX_HOST",
    "EMQX_USERNAME",
    "EMQX_PASSWORD",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY"
];

const missingEnv = requiredEnv.filter((key) => {
    const value = process.env[key];
    return !value || value.startsWith("YOUR_");
});

if (missingEnv.length > 0) {
    console.error(
        "THIEU CAU HINH ENVIRONMENT VARIABLES:",
        missingEnv.join(", ")
    );
    process.exit(1);
}

if (
    MQTT_HOST.includes("://") ||
    MQTT_HOST.includes("/") ||
    MQTT_HOST.includes(":")
) {
    console.error(
        "EMQX_HOST chi nhap hostname, khong nhap https://, port hoac /api/v5."
    );
    process.exit(1);
}

// ==================================================
// 3. KET NOI SUPABASE
// ==================================================

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false
        }
    }
);

// ==================================================
// 4. CAU HINH EXPRESS
// ==================================================

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==================================================
// 5. TRANG THAI HE THONG
// ==================================================

let latestSensor = null;

let latestDeviceStatus = {
    mode: "auto",
    led: false,
    buzzer: false,
    updatedAt: null
};

let mqttConnected = false;
let lastSupabaseSaveAt = 0;

let sensorMessagesReceived = 0;
let sensorRowsSaved = 0;
let sensorRowsSkipped = 0;

// ==================================================
// 6. KET NOI EMQX QUA TLS
// ==================================================

const mqttUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;

const mqttClient = mqtt.connect(mqttUrl, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,

    clientId:
        `smart4_backend_${Math.random()
            .toString(16)
            .slice(2, 10)}`,

    clean: true,
    connectTimeout: 15000,
    reconnectPeriod: 5000,
    rejectUnauthorized: true
});

mqttClient.on("connect", () => {
    mqttConnected = true;

    console.log("EMQX MQTT: KET NOI THANH CONG");

    mqttClient.subscribe(
        [TOPIC_SENSOR, TOPIC_STATUS],
        { qos: 0 },
        (error) => {
            if (error) {
                console.error(
                    "MQTT SUBSCRIBE LOI:",
                    error.message
                );
                return;
            }

            console.log("MQTT SUBSCRIBE:", TOPIC_SENSOR);
            console.log("MQTT SUBSCRIBE:", TOPIC_STATUS);
        }
    );
});

mqttClient.on("reconnect", () => {
    console.log("EMQX MQTT: DANG KET NOI LAI...");
});

mqttClient.on("close", () => {
    mqttConnected = false;
});

mqttClient.on("offline", () => {
    mqttConnected = false;
    console.log("EMQX MQTT: OFFLINE");
});

mqttClient.on("error", (error) => {
    mqttConnected = false;
    console.error("EMQX MQTT ERROR:", error.message);
});

// ==================================================
// 7. LUU DU LIEU CAM BIEN VAO SUPABASE
// ==================================================

async function saveSensorToSupabase(gas, light) {
    const now = Date.now();

    if (now - lastSupabaseSaveAt < SAVE_INTERVAL_MS) {
        sensorRowsSkipped++;
        return;
    }

    lastSupabaseSaveAt = now;

    try {
        const record = {
            gas,
            light,
            created_at: new Date().toISOString()
        };

        const { error } = await supabase
            .from("sensor_data")
            .insert([record]);

        if (error) {
            console.error(
                "SUPABASE SAVE ERROR:",
                error.message
            );
            return;
        }

        sensorRowsSaved++;

        console.log(
            `SUPABASE SAVED: Gas=${gas.toFixed(1)}%, ` +
            `Light=${light.toFixed(1)} lux`
        );
    } catch (error) {
        console.error("SUPABASE ERROR:", error.message);
    }
}

// ==================================================
// 8. NHAN DU LIEU MQTT
// ==================================================

mqttClient.on("message", async (topic, message) => {
    let data;

    try {
        data = JSON.parse(message.toString());
    } catch (error) {
        console.error("MQTT JSON ERROR:", error.message);
        return;
    }

    // 8.1. DU LIEU GAS VA ANH SANG

    if (topic === TOPIC_SENSOR) {
        const gas = Number(data.gas);
        const light = Number(data.light);

        if (
            !Number.isFinite(gas) ||
            !Number.isFinite(light)
        ) {
            console.error("DU LIEU GAS/LIGHT KHONG HOP LE");
            return;
        }

        sensorMessagesReceived++;

        latestSensor = {
            gas,
            light,
            receivedAt: new Date().toISOString()
        };

        console.log(
            `SENSOR: Gas=${gas.toFixed(1)}%, ` +
            `Light=${light.toFixed(1)} lux`
        );

        await saveSensorToSupabase(gas, light);
        return;
    }

    // 8.2. TRANG THAI ESP32

    if (topic === TOPIC_STATUS) {
        const validMode =
            ["auto", "manual"].includes(data.mode);

        if (!validMode) {
            console.error("STATUS: MODE KHONG HOP LE");
            return;
        }

        if (
            typeof data.led !== "boolean" ||
            typeof data.buzzer !== "boolean"
        ) {
            console.error(
                "STATUS: LED HOAC BUZZER KHONG HOP LE"
            );
            return;
        }

        latestDeviceStatus = {
            mode: data.mode,
            led: data.led,
            buzzer: data.buzzer,
            updatedAt: new Date().toISOString()
        };

        console.log(
            `DEVICE: mode=${latestDeviceStatus.mode}, ` +
            `LED=${latestDeviceStatus.led}, ` +
            `BUZZER=${latestDeviceStatus.buzzer}`
        );
    }
});

// ==================================================
// 9. API DU LIEU CAM BIEN MOI NHAT
// ==================================================

app.get("/api/sensor", async (req, res) => {
    try {
        if (latestSensor) {
            return res.json({
                success: true,
                ...latestSensor
            });
        }

        const { data, error } = await supabase
            .from("sensor_data")
            .select("id, gas, light, created_at")
            .order("id", { ascending: false })
            .limit(1);

        if (error) {
            throw error;
        }

        const row =
            data && data.length > 0 ? data[0] : null;

        return res.json({
            success: true,
            gas: row ? Number(row.gas) : null,
            light: row ? Number(row.light) : null,
            receivedAt: row ? row.created_at : null
        });
    } catch (error) {
        console.error("API SENSOR ERROR:", error.message);

        return res.status(500).json({
            success: false,
            message: "Khong lay duoc du lieu cam bien"
        });
    }
});

// ==================================================
// 10. API LICH SU CAM BIEN
// ==================================================

app.get("/api/history", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("sensor_data")
            .select("id, gas, light, created_at")
            .order("id", { ascending: false })
            .limit(30);

        if (error) {
            throw error;
        }

        const history = (data || [])
            .reverse()
            .map((row) => ({
                id: row.id,
                gas: Number(row.gas),
                light: Number(row.light),
                created_at: row.created_at
            }));

        return res.json({
            success: true,
            data: history
        });
    } catch (error) {
        console.error("API HISTORY ERROR:", error.message);

        return res.status(500).json({
            success: false,
            message: "Khong lay duoc lich su"
        });
    }
});

// ==================================================
// 11. API TRANG THAI MQTT VA ESP32
// ==================================================

app.get("/api/status", (req, res) => {
    res.json({
        success: true,
        mqttConnected,
        device: latestDeviceStatus
    });
});

// ==================================================
// 12. API DIEU KHIEN DEN VA COI
// ==================================================

app.post("/api/control", (req, res) => {
    if (!mqttConnected) {
        return res.status(503).json({
            success: false,
            message: "MQTT chua ket noi"
        });
    }

    const { mode, led, buzzer } = req.body || {};

    if (!["auto", "manual"].includes(mode)) {
        return res.status(400).json({
            success: false,
            message: "mode phai la auto hoac manual"
        });
    }

    const command = { mode };

    if (mode === "manual") {
        if (
            typeof led !== "boolean" ||
            typeof buzzer !== "boolean"
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Che do manual can led va buzzer la true/false"
            });
        }

        command.led = led;
        command.buzzer = buzzer;
    }

    mqttClient.publish(
        TOPIC_CONTROL,
        JSON.stringify(command),
        {
            qos: 0,
            retain: false
        },
        (error) => {
            if (error) {
                console.error(
                    "PUBLISH CONTROL ERROR:",
                    error.message
                );
            }
        }
    );

    console.log("CONTROL SENT:", JSON.stringify(command));

    return res.json({
        success: true,
        message: "Da gui lenh den ESP32",
        command
    });
});

// ==================================================
// 13. HEALTH CHECK
// ==================================================

app.get("/health", (req, res) => {
    res.json({
        success: true,
        server: "running",
        mqttConnected,
        sensorReceived: Boolean(latestSensor),
        sensorMessagesReceived,
        sensorRowsSaved,
        sensorRowsSkipped,
        saveIntervalMs: SAVE_INTERVAL_MS
    });
});

// ==================================================
// 14. KHOI DONG SERVER
// ==================================================

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log("==================================");
    console.log("SMART4 BACKEND");
    console.log(`WEB SERVER PORT: ${PORT}`);
    console.log(`EMQX HOST: ${MQTT_HOST}`);
    console.log(`EMQX MQTT PORT: ${MQTT_PORT}`);
    console.log(`SENSOR TOPIC: ${TOPIC_SENSOR}`);
    console.log(`CONTROL TOPIC: ${TOPIC_CONTROL}`);
    console.log(`STATUS TOPIC: ${TOPIC_STATUS}`);
    console.log(`SUPABASE SAVE INTERVAL: ${SAVE_INTERVAL_MS} ms`);
    console.log("DATABASE: SUPABASE");
    console.log("==================================");
});

// ==================================================
// 15. DONG KET NOI KHI DUNG SERVER
// ==================================================

let isShuttingDown = false;

function shutdown() {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;

    console.log("Dang dung Smart4...");

    mqttClient.end(false, () => {
        server.close(() => {
            process.exit(0);
        });
    });

    setTimeout(() => {
        process.exit(0);
    }, 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
