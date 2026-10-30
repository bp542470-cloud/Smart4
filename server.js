//Node.js
"use strict";

require("dotenv").config();

const express = require("express");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;


// 1. CAU HINH EMQX MQTT


const MQTT_HOST = process.env.EMQX_HOST;
const MQTT_PORT = Number(process.env.EMQX_PORT) || 8883;
const MQTT_USERNAME = process.env.EMQX_USERNAME;
const MQTT_PASSWORD = process.env.EMQX_PASSWORD;

const TOPIC_SENSOR = "nhansida/iot/sensor";
const TOPIC_CONTROL = "nhansida/iot/control";
const TOPIC_STATUS = "nhansida/iot/status";


// 2. CAU HINH SUPABASE


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

const missingEnv = requiredEnv.filter(key => {
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


// 3. CAU HINH EXPRESS backend 


app.use(express.json({ limit: "20kb" }));

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});


// 4. BIEN LUU TRANG THAI


let latestSensor = null;

let latestDeviceStatus = {
    mode: "auto",
    led: false,
    buzzer: false,
    emergency: false,
    updatedAt: null
};

let mqttConnected = false;

let lastSupabaseSaveAt = 0;

let sensorMessagesReceived = 0;
let sensorRowsSaved = 0;
let sensorRowsSkipped = 0;


// 5. UOC TINH ALCOHOL VA SMOKE


// Luu y:
// Day chi la gia tri uoc tinh tu cam bien gas,
// khong phai so do thuc te cua cam bien alcohol/smoke.

function calculateEstimates(gas) {
    const safeGas = Math.max(0, Math.min(100, gas));

    return {
        alcohol_ppm: Math.round(safeGas * 100),
        smoke_ugm3: Math.round(safeGas * 50)
    };
}

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

// ==================================================
// 6. KET NOI MQTT EMQX HiveMQ Cloud
// ==================================================

const mqttUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;

const mqttClient = mqtt.connect(mqttUrl, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,

    clientId:
        `smart4_backend_${Math.random().toString(16).slice(2, 10)}`,

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

// ==================================================
// 7. LUU DU LIEU CAM BIEN VAO SUPABASE
// ==================================================

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
            `Light=${record.light.toFixed(1)}, ` +
            `Alcohol estimate=${record.alcohol_ppm} ppm, ` +
            `Smoke estimate=${record.smoke_ugm3} ug/m3`
        );
    } catch (error) {
        console.error("SUPABASE ERROR:", error.message);
    }
}

// ==================================================
// 8. NHAN DU LIEU TU MQTT
// ==================================================

mqttClient.on("message", async (topic, message) => {
    let data;

    try {
        data = JSON.parse(message.toString());
    } catch (error) {
        console.error("MQTT JSON ERROR:", error.message);
        return;
    }

    // ----------------------------------------------
    // 8.1. DU LIEU CAM BIEN
    // ----------------------------------------------

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
            console.error(
                "DU LIEU GAS/LIGHT KHONG HOP LE"
            );

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
            `Light=${light.toFixed(1)}, ` +
            `Alcohol estimate=${sensor.alcohol_ppm} ppm, ` +
            `Smoke estimate=${sensor.smoke_ugm3} ug/m3`
        );

        await saveSensorToSupabase(sensor);

        return;
    }

    // ----------------------------------------------
    // 8.2. TRANG THAI THIET BI
    // ----------------------------------------------

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
            console.error(
                "STATUS: LED HOAC BUZZER KHONG HOP LE"
            );

            return;
        }

        // Tuong thich voi firmware cu chua co emergency.
        const emergency = typeof data.emergency === "boolean"
            ? data.emergency
            : false;

        latestDeviceStatus = {
            mode: data.mode,
            led: data.led,
            buzzer: data.buzzer,
            emergency,
            updatedAt: new Date().toISOString()
        };

        console.log(
            "DEVICE STATUS:",
            JSON.stringify(latestDeviceStatus)
        );
    }
});

// ==================================================
// 9. API LAY CAM BIEN MOI NHAT
// ==================================================

app.get("/api/sensor", (req, res) => {
    if (!latestSensor) {
        return res.status(503).json({
            success: false,
            message: "Chua nhan duoc du lieu cam bien",
            data: null
        });
    }

    return res.json({
        success: true,
        data: latestSensor
    });
});

// ==================================================
// 10. API LAY LICH SU CAM BIEN
// ==================================================

app.get("/api/history", async (req, res) => {
    try {
        const requestedLimit = Number(req.query.limit) || 30;

        const limit = Math.max(
            1,
            Math.min(200, Math.floor(requestedLimit))
        );

        const { data, error } = await supabase
            .from("sensor_data")
            .select(
                "id, gas, light, alcohol_ppm, smoke_ugm3, created_at"
            )
            .order("created_at", { ascending: false })
            .limit(limit);

        if (error) {
            console.error(
                "SUPABASE HISTORY ERROR:",
                error.message
            );

            return res.status(500).json({
                success: false,
                message: "Khong lay duoc lich su cam bien"
            });
        }

        const rows = (data || [])
            .map(normalizeSensorRow)
            .reverse();

        return res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("HISTORY API ERROR:", error.message);

        return res.status(500).json({
            success: false,
            message: "Loi khi lay lich su"
        });
    }
});

// ==================================================
// 11. API LAY TRANG THAI HE THONG
// ==================================================

app.get("/api/status", (req, res) => {
    return res.json({
        success: true,
        mqttConnected,
        backend: "online",
        device: latestDeviceStatus,
        sensorMessagesReceived,
        sensorRowsSaved,
        sensorRowsSkipped,
        serverTime: new Date().toISOString()
    });
});

// ==================================================
// 12. HAM GUI LENH DIEU KHIEN QUA MQTT
// ==================================================

function publishControl(payload, res) {
    if (!mqttConnected || !mqttClient.connected) {
        return res.status(503).json({
            success: false,
            message: "MQTT chua ket noi. Khong gui duoc lenh."
        });
    }

    const message = JSON.stringify(payload);

    mqttClient.publish(
        TOPIC_CONTROL,
        message,
        { qos: 0, retain: false },
        error => {
            if (error) {
                console.error(
                    "MQTT PUBLISH ERROR:",
                    error.message
                );

                return res.status(500).json({
                    success: false,
                    message: "Gui lenh MQTT that bai"
                });
            }

            console.log(
                "MQTT CONTROL SENT:",
                message
            );

            return res.json({
                success: true,
                message: "Da gui lenh qua MQTT",
                command: payload
            });
        }
    );
}

// ==================================================
// 13. API DIEU KHIEN AUTO / MANUAL / LED / BUZZER
// ==================================================

app.post("/api/control", (req, res) => {
    const { mode, led, buzzer } = req.body || {};

    // Chuyen sang che do tu dong.
    if (mode === "auto") {
        return publishControl(
            {
                mode: "auto"
            },
            res
        );
    }

    // Chuyen sang che do thu cong.
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

        return publishControl(
            {
                mode: "manual",
                led,
                buzzer
            },
            res
        );
    }

    // Neu chi gui led/buzzer, su dung che do manual.
    if (
        typeof led === "boolean" &&
        typeof buzzer === "boolean"
    ) {
        return publishControl(
            {
                mode: "manual",
                led,
                buzzer
            },
            res
        );
    }

    return res.status(400).json({
        success: false,
        message: "Lenh dieu khien khong hop le"
    });
});

// ==================================================
// 14. API CANH BAO SIEU NGUY HIEM
// ==================================================

// Website gui:
// { "enabled": true }  -> bat canh bao
// { "enabled": false } -> tat canh bao
//
// Firmware ESP32 phai duoc cap nhat de thuc hien
// nhap nhay LED va keu buzzer khi nhan lenh nay.

app.post("/api/emergency", (req, res) => {
    const { enabled } = req.body || {};

    if (typeof enabled !== "boolean") {
        return res.status(400).json({
            success: false,
            message: "enabled phai la true hoac false"
        });
    }

    return publishControl(
        {
            emergency: enabled
        },
        res
    );
});

// ==================================================
// 15. API KIEM TRA SERVER
// ==================================================

app.get("/health", (req, res) => {
    return res.json({
        success: true,
        server: "online",
        mqttConnected,
        uptime: Math.round(process.uptime()),
        time: new Date().toISOString()
    });
});

// ==================================================
// 16. XU LY API KHONG TON TAI
// ==================================================

app.use("/api", (req, res) => {
    return res.status(404).json({
        success: false,
        message: "API khong ton tai"
    });
});

// ==================================================
// 17. XU LY LOI SERVER
// ==================================================

app.use((error, req, res, next) => {
    console.error("SERVER ERROR:", error.message);

    if (res.headersSent) {
        return next(error);
    }

    return res.status(500).json({
        success: false,
        message: "Loi noi bo server"
    });
});

// 18. KHOI DONG SERVER khởi chạy máy chủ Node.js
// ==================================================

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log("------------------------------------");
    console.log("SMART4 BACKEND DANG CHAY");
    console.log(`Website: http://localhost:${PORT}`);
    console.log(`Health:  http://localhost:${PORT}/health`);
    console.log(`MQTT Host: ${MQTT_HOST}`);
    console.log(`Sensor topic: ${TOPIC_SENSOR}`);
    console.log(`Control topic: ${TOPIC_CONTROL}`);
    console.log(`Status topic: ${TOPIC_STATUS}`);
    console.log("------------------------------------");
});

// Dong ket noi khi dung server.
function shutdown() {
    console.log("DANG DUNG SMART4 SERVER...");

    mqttClient.end(true);

    server.close(() => {
        console.log("SMART4 SERVER DA DUNG");
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(1);
    }, 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);