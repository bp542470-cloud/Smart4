require("dotenv").config();

const express = require("express");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// ===============================
// SUPABASE
// ===============================

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);

// ===============================
// MQTT HIVEMQ
// ===============================

const mqttClient = mqtt.connect(
    `mqtts://${process.env.HIVEMQ_HOST}:${process.env.HIVEMQ_PORT}`,
    {
        username: process.env.HIVEMQ_USERNAME,
        password: process.env.HIVEMQ_PASSWORD,

        clientId:
            "smart4_backend_" +
            Math.random().toString(16).slice(2),

        rejectUnauthorized: false,
        reconnectPeriod: 5000,
        connectTimeout: 30000
    }
);

// ===============================
// MQTT CONNECT
// ===============================

mqttClient.on("connect", () => {
    console.log("");
    console.log("====================================");
    console.log("MQTT HIVEMQ: KET NOI THANH CONG");
    console.log("====================================");

    mqttClient.subscribe(
        "nhansida/iot/sensor",
        (err) => {
            if (err) {
                console.error(
                    "MQTT SUBSCRIBE ERROR:",
                    err.message
                );
            } else {
                console.log(
                    "MQTT SUBSCRIBE: nhansida/iot/sensor"
                );
            }
        }
    );
});

// ===============================
// NHẬN DỮ LIỆU MQTT
// ===============================

mqttClient.on("message", async (topic, message) => {
    try {
        console.log("");
        console.log("MQTT MESSAGE RECEIVED");
        console.log("Topic:", topic);

        const data = JSON.parse(message.toString());

        console.log("Data:", message.toString());

        const gas = Number(data.gas);
        const light = Number(data.light);

        console.log("Gas:", gas);
        console.log("Light:", light);

        if (
            !Number.isFinite(gas) ||
            !Number.isFinite(light)
        ) {
            console.log("DU LIEU KHONG HOP LE");
            return;
        }

        // ===============================
        // LƯU VÀO SUPABASE
        // ===============================

        const { data: savedData, error } =
            await supabase
                .from("sensor_data")
                .insert([
                    {
                        gas: gas,
                        light: light
                    }
                ])
                .select();

        if (error) {
            console.error(
                "SUPABASE INSERT ERROR:",
                error.message
            );
            return;
        }

        console.log(
            "SUPABASE SAVED:",
            savedData
        );

    } catch (error) {
        console.error(
            "MQTT DATA ERROR:",
            error.message
        );
    }
});

// ===============================
// MQTT ERROR
// ===============================

mqttClient.on("error", (error) => {
    console.error(
        "MQTT ERROR:",
        error.message
    );
});

// ===============================
// MQTT CLOSE
// ===============================

mqttClient.on("close", () => {
    console.log("MQTT: MAT KET NOI");
});

// ===============================
// MQTT RECONNECT
// ===============================

mqttClient.on("reconnect", () => {
    console.log(
        "MQTT: DANG KET NOI LAI..."
    );
});

// ===============================
// API SENSOR
// ===============================

app.get("/api/sensor", async (req, res) => {
    try {
        const {
            data,
            error
        } = await supabase
            .from("sensor_data")
            .select(
                "id, light, gas, created_at"
            )
            .order(
                "id",
                {
                    ascending: false
                }
            )
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error(
                "SUPABASE SENSOR ERROR:",
                error.message
            );

            return res.status(500).json({
                error: error.message
            });
        }

        if (!data) {
            return res.json({
                gas: 0,
                light: 0,
                created_at: null
            });
        }

        res.json({
            gas: Number(data.gas),
            light: Number(data.light),
            created_at: data.created_at
        });

    } catch (error) {
        console.error(
            "API SENSOR ERROR:",
            error.message
        );

        res.status(500).json({
            error: error.message
        });
    }
});

// ===============================
// API HISTORY
// ===============================

app.get("/api/history", async (req, res) => {
    try {
        const {
            data,
            error
        } = await supabase
            .from("sensor_data")
            .select(
                "id, light, gas, created_at"
            )
            .order(
                "id",
                {
                    ascending: false
                }
            )
            .limit(30);

        if (error) {
            console.error(
                "SUPABASE HISTORY ERROR:",
                error.message
            );

            return res.status(500).json({
                error: error.message
            });
        }

        const history = (data || []).reverse();

        res.json(history);

    } catch (error) {
        console.error(
            "API HISTORY ERROR:",
            error.message
        );

        res.status(500).json({
            error: error.message
        });
    }
});

// ===============================
// HEALTH CHECK
// ===============================

app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        mqtt: mqttClient.connected,
        supabase: true
    });
});

// ===============================
// TRANG CHỦ
// ===============================

app.get("/", (req, res) => {
    res.sendFile(
        __dirname + "/public/index.html"
    );
});

// ===============================
// START SERVER
// ===============================

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log("");
        console.log("====================================");
        console.log("SMART4 BACKEND");
        console.log("====================================");
        console.log(
            "WEB SERVER: http://localhost:" +
            PORT
        );
        console.log(
            "MQTT HOST:",
            process.env.HIVEMQ_HOST
        );
        console.log(
            "MQTT TOPIC: nhansida/iot/sensor"
        );
        console.log(
            "DATABASE: SUPABASE"
        );
        console.log("====================================");
        console.log("");
    }
);