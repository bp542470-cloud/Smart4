"use strict";

require("dotenv").config();

const express = require("express");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

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

const requiredEnv = [
    "EMQX_HOST",
    "EMQX_USERNAME",
    "EMQX_PASSWORD",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY"
];

const missingEnv = requiredEnv.filter(key =>
    !process.env[key] ||
    process.env[key].startsWith("YOUR_")
);

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
        "EMQX_HOST chi nhap hostname, khong nhap giao thuc hoac port."
    );
    process.exit(1);
}

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

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* DU LIEU CAM BIEN MOI NHAT */

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

/*
 * ALCOHOL VA SMOKE LA GIA TRI UOC TINH
 * TU GAS DE HIEN THI TREN DASHBOARD.
 *
 * KHONG PHAI CONG THUC HIEU CHUAN CAM BIEN.
 * KHONG DUNG CHO MUC DICH AN TOAN.
 */
function calculateEstimates(gas) {
    const safeGas = Math.max(0, Math.min(100, gas));

    return {
        alcohol_ppm: Math.round(safeGas * 100),
        smoke_ugm3: Math.round(safeGas * 50)
    };
}

/*
 * DAM BAO BAN GHI CO DAY DU CAC TRUONG UOC TINH.
 * Neu ban ghi cu bi null, tinh lai tu gas de hien thi.
 */
function normalizeSensorRow(row) {
    const gas = Number(row.gas);
    const light = Number(row.light);

    const estimates = calculateEstimates(gas);

    return {
        id: row.id,
        gas,
        light,
        alcohol_ppm: row.alcohol_ppm == null
            ? estimates.alcohol_ppm
            : Number(row.alcohol_ppm),
        smoke_ugm3: row.smoke_ugm3 == null
            ? estimates.smoke_ugm3
            : Number(row.smoke_ugm3),
        created_at: row.created_at
    };
}

/* KET NOI EMQX */

const mqttUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;

const mqttClient = mqtt.connect(mqttUrl, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clientId: `smart4_backend_${Math.random()
        .toString(16).slice(2, 10)}`,
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
        error => {
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

mqttClient.on("error", error => {
    mqttConnected = false;
    console.error("EMQX MQTT ERROR:", error.message);
});

/*
 * LUU DU LIEU CAM BIEN VAO SUPABASE.
 *
 * TINH LAI ALCOHOL VA SMOKE TU GAS NGAY TRUOC KHI INSERT,
 * KHONG SU DUNG GIA TRI DAU VAO CO THE BI THIEU.
 */
async function saveSensorToSupabase(sensor) {
    const now = Date.now();

    if (now - lastSupabaseSaveAt < SAVE_INTERVAL_MS) {
        sensorRowsSkipped++;
        return;
    }

    lastSupabaseSaveAt = now;

    try {
        const estimates = calculateEstimates(sensor.gas);

        const record = {
            gas: sensor.gas,
            light: sensor.light,
            alcohol_ppm: estimates.alcohol_ppm,
            smoke_ugm3: estimates.smoke_ugm3,
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from("sensor_data")
            .insert([record])
            .select("id")
            .single();

        if (error) {
            console.error(
                "SUPABASE SAVE ERROR:",
                error.message
            );
            return;
        }

        sensorRowsSaved++;

        console.log(
            `SUPABASE SAVED: ID=${data.id}, ` +
            `Gas=${record.gas.toFixed(1)}%, ` +
            `Light=${record.light.toFixed(1)} lux, ` +
            `Alcohol estimate=${record.alcohol_ppm} ppm, ` +
            `Smoke estimate=${record.smoke_ugm3} ug/m3`
        );
    } catch (error) {
        console.error("SUPABASE ERROR:", error.message);
    }
}

/* NHAN DU LIEU MQTT */

mqttClient.on("message", async (topic, message) => {
    let data;

    try {
        data = JSON.parse(message.toString());
    } catch (error) {
        console.error("MQTT JSON ERROR:", error.message);
        return;
    }

    if (topic === TOPIC_SENSOR) {
        const gas = Number(data.gas);
        const light = Number(data.light);

        if (
            !Number.isFinite(gas) ||
            !Number.isFinite(light) ||
            gas < 0 ||
            gas > 100 ||
            light < 0
        ) {
            console.error("DU LIEU GAS/LIGHT KHONG HOP LE");
            return;
        }

        const estimates = calculateEstimates(gas);

        const sensor = {
            gas,
            light,
            alcohol_ppm: estimates.alcohol_ppm,
            smoke_ugm3: estimates.smoke_ugm3,
            estimatesOnly: true,
            receivedAt: new Date().toISOString()
        };

        latestSensor = sensor;
        sensorMessagesReceived++;

        console.log(
            `SENSOR: Gas=${gas.toFixed(1)}%, ` +
            `Light=${light.toFixed(1)} lux, ` +
            `Alcohol estimate=${sensor.alcohol_ppm} ppm, ` +
            `Smoke estimate=${sensor.smoke_ugm3} ug/m3`
        );

        await saveSensorToSupabase(sensor);
        return;
    }

    if (topic === TOPIC_STATUS) {
        const validMode = ["auto", "manual"].includes(data.mode);

        if (!validMode) {
            console.error("STATUS: MODE KHONG HOP LE");
            return;
        }

        if (
            typeof data.led !== "boolean" ||
            typeof data.buzzer !== "boolean"
        ) {
            console.error("STATUS: LED HOAC BUZZER KHONG HOP LE");
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

/* API CAM BIEN MOI NHAT */

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
            .select(
                "id, gas, light, alcohol_ppm, smoke_ugm3, created_at"
            )
            .order("id", { ascending: false })
            .limit(1);

        if (error) throw error;

        const row = data && data.length > 0 ? data[0] : null;

        if (!row) {
            return res.json({
                success: true,
                gas: null,
                light: null,
                alcohol_ppm: null,
                smoke_ugm3: null,
                estimatesOnly: true,
                receivedAt: null
            });
        }

        const normalized = normalizeSensorRow(row);

        return res.json({
            success: true,
            ...normalized,
            estimatesOnly: true,
            receivedAt: row.created_at
        });
    } catch (error) {
        console.error("API SENSOR ERROR:", error.message);

        return res.status(500).json({
            success: false,
            message: "Khong lay duoc du lieu cam bien"
        });
    }
});

/* API LICH SU 30 MAU */

app.get("/api/history", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("sensor_data")
            .select(
                "id, gas, light, alcohol_ppm, smoke_ugm3, created_at"
            )
            .order("id", { ascending: false })
            .limit(30);

        if (error) throw error;

        const history = (data || [])
            .map(normalizeSensorRow)
            .reverse();

        return res.json({
            success: true,
            estimatesOnly: true,
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

/* API TRANG THAI */

app.get("/api/status", (req, res) => {
    res.json({
        success: true,
        mqttConnected,
        device: latestDeviceStatus
    });
});

/* API DIEU KHIEN LED VA BUZZER */

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
        { qos: 0, retain: false },
        error => {
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

/* API KIEM TRA BACKEND */

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

/* KHOI DONG WEB SERVER */

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
    console.log("NOTE: ALCOHOL/SMOKE ARE DEMONSTRATION ESTIMATES");
    console.log("==================================");
});

/* DUNG SERVER AN TOAN */

let isShuttingDown = false;

function shutdown() {
    if (isShuttingDown) return;

    isShuttingDown = true;
    console.log("Dang dung Smart4...");

    mqttClient.end(false, () => {
        server.close(() => process.exit(0));
    });

    setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
