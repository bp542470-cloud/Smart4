
"use strict";

// ==================================================
// SMART4 DASHBOARD
// GAS - LIGHT - SMOKE - ALCOHOL - EMERGENCY
// ==================================================

const API_SENSOR = "/api/sensor";
const API_HISTORY = "/api/history";
const API_STATUS = "/api/status";
const API_CONTROL = "/api/control";
const API_EMERGENCY = "/api/emergency";

const MAX_POINTS = 30;
const SENSOR_INTERVAL = 3000;
const STATUS_INTERVAL = 3000;
const HISTORY_INTERVAL = 10000;
const EMERGENCY_CONFIRM_TIMEOUT = 15000;

let currentMode = "auto";
let currentLed = false;
let currentBuzzer = false;
let currentEmergency = false;
let currentMqttConnected = false;

let controlBusy = false;
let historyLoading = false;
let dashboardStarted = false;

let pendingEmergency = null;
let pendingEmergencyAt = 0;

const gauges = {};
const charts = {};

// ==================================================
// 1. HÀM TIỆN ÍCH
// ==================================================

function $(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
}

function setClass(id, className) {
    const element = $(id);
    if (element) element.className = className;
}

function finiteNumber(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatNumber(value, digits = 1) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
        return "--";
    }

    return Number(value).toLocaleString("vi-VN", {
        maximumFractionDigits: digits
    });
}

function formatTime(value) {
    if (!value) return "--";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "--";
    }

    return date.toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

async function getJSON(url, options = {}) {
    const response = await fetch(url, {
        cache: "no-store",
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const body = await response.text();

    let result;

    try {
        result = body ? JSON.parse(body) : {};
    } catch {
        throw new Error(
            `${url} không trả về JSON hợp lệ (HTTP ${response.status}).`
        );
    }

    if (!response.ok) {
        throw new Error(
            result.message || `Yêu cầu thất bại: HTTP ${response.status}`
        );
    }

    return result;
}

function normalizeRows(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.data)) return result.data;
    if (Array.isArray(result?.history)) return result.history;
    if (Array.isArray(result?.rows)) return result.rows;

    return [];
}

// Chỉ khởi tạo ECharts vào đúng phần tử được chỉ định.
// Không sử dụng lại một biểu đồ của phần tử khác.
function initEChart(elementId) {
    const element = $(elementId);

    if (!element) {
        console.error(`[ECHART] Không tìm thấy phần tử #${elementId}`);
        return null;
    }

    if (typeof echarts === "undefined") {
        console.error("[ECHART] Thư viện ECharts chưa được tải.");
        return null;
    }

    // Phần tử cần có kích thước thực tế trước khi khởi tạo.
    const rect = element.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0) {
        console.warn(
            `[ECHART] #${elementId} chưa có kích thước hợp lệ.`,
            rect.width,
            rect.height
        );
    }

    let instance = echarts.getInstanceByDom(element);

    if (!instance) {
        instance = echarts.init(element);
    }

    return instance;
}

// ==================================================
// 2. TẠO ĐỒNG HỒ CẢM BIẾN
// ==================================================

function createGauge(elementId, config) {
    const chart = initEChart(elementId);

    if (!chart) return null;

    chart.setOption({
        backgroundColor: "transparent",
        animationDuration: 500,

        series: [{
            type: "gauge",
            min: config.min,
            max: config.max,
            startAngle: config.startAngle,
            endAngle: config.endAngle,
            center: config.center || ["50%", "53%"],
            radius: config.radius || "88%",

            progress: {
                show: true,
                width: config.width || 13,
                roundCap: config.roundCap ?? true,
                itemStyle: {
                    color: config.color
                }
            },

            axisLine: {
                roundCap: config.roundCap ?? true,
                lineStyle: {
                    width: config.width || 13,
                    color: [[1, "#293548"]]
                }
            },

            pointer: {
                show: config.pointer !== false,
                length: config.pointerLength || "55%",
                width: config.pointerWidth || 4,
                itemStyle: {
                    color: config.color
                }
            },

            axisTick: {
                show: config.showTicks !== false,
                distance: config.tickDistance ?? -19,
                length: config.tickLength || 4,
                lineStyle: {
                    color: "#94a3b8",
                    width: 1
                }
            },

            splitLine: {
                show: true,
                distance: config.splitDistance ?? -20,
                length: config.splitLength || 9,
                lineStyle: {
                    color: "#cbd5e1",
                    width: 2
                }
            },

            axisLabel: {
                show: config.showLabels !== false,
                distance: config.labelDistance ?? 13,
                color: "#94a3b8",
                fontSize: config.labelFontSize || 10
            },

            anchor: {
                show: config.pointer !== false,
                showAbove: true,
                size: 8,
                itemStyle: {
                    color: "#f8fafc",
                    borderWidth: 2,
                    borderColor: config.color
                }
            },

            title: {
                show: true,
                offsetCenter: config.titleOffset || [0, "62%"],
                color: "#94a3b8",
                fontSize: 12
            },

            detail: {
                show: true,
                valueAnimation: true,
                offsetCenter: config.detailOffset || [0, "29%"],
                fontSize: config.detailFontSize || 19,
                fontWeight: "bold",
                color: "#f8fafc",

                formatter(value) {
                    return `${formatNumber(value, config.digits ?? 1)} ${config.unit}`;
                }
            },

            data: [{
                value: config.min,
                name: config.title
            }]
        }]
    });

    return chart;
}

function updateGauge(chart, value, title, min, max) {
    if (!chart || value === null) return;

    const displayedValue = Math.max(min, Math.min(max, value));

    chart.setOption({
        series: [{
            data: [{
                value: displayedValue,
                name: title
            }]
        }]
    });
}

function initGauges() {
    gauges.gas = createGauge("gasGauge", {
        title: "Khí gas",
        unit: "%",
        min: 0,
        max: 100,
        startAngle: 210,
        endAngle: -30,
        color: "#f87171",
        width: 15,
        radius: "90%",
        roundCap: true,
        pointer: true,
        showTicks: true,
        showLabels: true,
        digits: 1
    });

    gauges.light = createGauge("lightGauge", {
        title: "Ánh sáng",
        unit: "lux",
        min: 0,
        max: 20000,
        startAngle: 90,
        endAngle: -270,
        center: ["50%", "48%"],
        color: "#facc15",
        width: 19,
        radius: "78%",
        roundCap: true,
        pointer: false,
        showTicks: false,
        showLabels: false,
        titleOffset: [0, "65%"],
        detailOffset: [0, "8%"],
        detailFontSize: 20,
        digits: 0
    });

    gauges.smoke = createGauge("smokeGauge", {
        title: "Chỉ số khói ước tính",
        unit: "µg/m³",
        min: 0,
        max: 5000,
        startAngle: 180,
        endAngle: 0,
        center: ["50%", "65%"],
        color: "#a78bfa",
        width: 15,
        radius: "88%",
        roundCap: false,
        pointer: true,
        pointerLength: "52%",
        showTicks: true,
        showLabels: true,
        tickDistance: -17,
        splitDistance: -18,
        labelDistance: 5,
        titleOffset: [0, "35%"],
        detailOffset: [0, "5%"],
        digits: 0
    });

    gauges.alcohol = createGauge("alcoholGauge", {
        title: "Hơi cồn ước tính",
        unit: "ppm",
        min: 0,
        max: 10000,
        startAngle: 225,
        endAngle: -45,
        center: ["50%", "54%"],
        color: "#38bdf8",
        width: 11,
        radius: "84%",
        roundCap: true,
        pointer: true,
        pointerLength: "62%",
        pointerWidth: 3,
        showTicks: true,
        showLabels: true,
        tickDistance: -15,
        splitDistance: -16,
        splitLength: 7,
        labelDistance: 9,
        labelFontSize: 9,
        detailFontSize: 17,
        digits: 0
    });
}

// ==================================================
// 3. CẤU HÌNH BIỂU ĐỒ LỊCH SỬ
// ==================================================

function chartBase(title, unit, color, type) {
    return {
        backgroundColor: "transparent",
        animationDuration: 300,
        color: [color],

        tooltip: {
            trigger: "axis",

            formatter(params) {
                if (!params || !params.length) return "";

                const item = params[0];
                const value = finiteNumber(item.value);

                return [
                    `<strong>${item.axisValue}</strong>`,
                    `${title}: ${
                        value === null
                            ? "Không có dữ liệu"
                            : `${formatNumber(value)} ${unit}`
                    }`
                ].join("<br>");
            }
        },

        grid: {
            left: 65,
            right: 20,
            top: 30,
            bottom: 45,
            containLabel: true
        },

        xAxis: {
            type: "category",
            data: [],
            boundaryGap: type === "bar",

            axisLabel: {
                color: "#94a3b8",
                hideOverlap: true
            },

            axisLine: {
                lineStyle: {
                    color: "#374151"
                }
            },

            axisTick: {
                show: false
            }
        },

        yAxis: {
            type: "value",
            scale: true,
            name: unit,

            nameTextStyle: {
                color: "#94a3b8"
            },

            axisLabel: {
                color: "#94a3b8",

                formatter(value) {
                    return Number(value).toLocaleString("vi-VN");
                }
            },

            axisTick: {
                show: false
            },

            splitLine: {
                lineStyle: {
                    color: "#293548",
                    type: "dashed"
                }
            }
        },

        series: [],

        graphic: [{
            type: "text",
            left: "center",
            top: "middle",
            silent: true,

            style: {
                text: "Đang tải lịch sử...",
                fill: "#94a3b8",
                fontSize: 13
            }
        }]
    };
}

function initOneHistoryChart(elementId, title, unit, color, type) {
    const chart = initEChart(elementId);

    if (!chart) return null;

    const option = chartBase(title, unit, color, type);

    if (type === "bar") {
        option.series = [{
            name: title,
            type: "bar",
            data: [],
            barMaxWidth: 28,

            itemStyle: {
                color: new echarts.graphic.LinearGradient(
                    0, 0, 0, 1,
                    [
                        { offset: 0, color: color },
                        { offset: 1, color: "#334155" }
                    ]
                ),
                borderRadius: [6, 6, 0, 0]
            }
        }];
    } else {
        option.series = [{
            name: title,
            type: "line",
            data: [],
            smooth: 0.25,
            showSymbol: true,
            symbol: "circle",
            symbolSize: 6,
            connectNulls: false,

            lineStyle: {
                width: 3,
                color: color
            },

            itemStyle: {
                color: color
            },

            areaStyle: {
                opacity: 0.12,
                color: color
            }
        }];
    }

    if (elementId === "gasChart") {
        option.series[0].markLine = {
            silent: true,
            symbol: "none",
            lineStyle: {
                color: "#fbbf24",
                type: "dashed",
                width: 2
            },
            label: {
                color: "#fbbf24",
                formatter: "Ngưỡng 35%"
            },
            data: [{ yAxis: 35 }]
        };
    }

    if (elementId === "lightChart") {
        option.series[0].markLine = {
            silent: true,
            symbol: "none",
            lineStyle: {
                color: "#38bdf8",
                type: "dashed",
                width: 2
            },
            label: {
                color: "#38bdf8",
                formatter: "Ngưỡng 300 lux"
            },
            data: [{ yAxis: 300 }]
        };
    }

    chart.setOption(option, true);

    return chart;
}

function initCharts() {
    // Mỗi biểu đồ dùng đúng phần tử HTML của nó.
    charts.gas = initOneHistoryChart(
        "gasChart", "Khí gas", "%", "#f87171", "line"
    );

    charts.light = initOneHistoryChart(
        "lightChart", "Ánh sáng", "lux", "#facc15", "line"
    );

    charts.smoke = initOneHistoryChart(
        "smokeChart", "Chỉ số khói ước tính", "µg/m³", "#a78bfa", "bar"
    );

    charts.alcohol = initOneHistoryChart(
        "alcoholChart", "Hơi cồn ước tính", "ppm", "#38bdf8", "line"
    );
}

// ==================================================
// 4. CẬP NHẬT BIỂU ĐỒ LỊCH SỬ
// ==================================================
const liveChartData = {
    gas: { labels: [], values: [] },
    light: { labels: [], values: [] },
    smoke: { labels: [], values: [] },
    alcohol: { labels: [], values: [] }
};

function appendLiveChart(key, value) {
    const chart = charts[key];

    if (!chart || value === null || !Number.isFinite(value)) return;

    const data = liveChartData[key];
    const now = new Date().toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    data.labels.push(now);
    data.values.push(value);

    while (data.labels.length > MAX_POINTS) {
        data.labels.shift();
        data.values.shift();
    }

    chart.setOption({
        xAxis: {
            data: data.labels
        },
        series: [{
            data: data.values
        }],
        graphic: [{
            type: "text",
            left: "center",
            top: "middle",
            silent: true,
            style: {
                text: "",
                fill: "#94a3b8",
                fontSize: 13
            }
        }]
    });
}

function updateLiveCharts(gas, light, smoke, alcohol) {
    appendLiveChart("gas", gas);
    appendLiveChart("light", light);
    appendLiveChart("smoke", smoke);
    appendLiveChart("alcohol", alcohol);
}
function historyLabel(row, index) {
    if (row?.created_at) {
        const time = formatTime(row.created_at);
        if (time !== "--") return time;
    }

    if (row?.id !== undefined && row?.id !== null) {
        return `ID ${row.id}`;
    }

    return `Mẫu ${index + 1}`;
}

function updateHistoryChart(chart, rows, field, title) {
    if (!chart) return;

    const labels = [];
    const values = [];

    rows.forEach((row, index) => {
        let value = finiteNumber(row?.[field]);

        // Bảng Supabase hiện có thể chỉ lưu gas và light.
        // Khói và hơi cồn ở đây chỉ là ước tính từ gas, không phải phép đo riêng.
        const gas = finiteNumber(row?.gas);

        if (value === null && gas !== null && field === "smoke_ugm3") {
            value = gas * 50;
        }

        if (value === null && gas !== null && field === "alcohol_ppm") {
            value = gas * 100;
        }

        if (value === null) return;

        labels.push(historyLabel(row, index));
        values.push(value);
    });

    // Cập nhật đúng instance, không khởi tạo lại trên đồng hồ.
    chart.setOption({
        xAxis: {
            data: labels
        },

        series: [{
            data: values
        }],

        graphic: [{
            type: "text",
            left: "center",
            top: "middle",
            silent: true,

            style: {
                text: values.length ? "" : "Chưa có dữ liệu lịch sử",
                fill: "#94a3b8",
                fontSize: 13
            }
        }]
    });

    chart.resize();
}

async function loadHistory() {
    if (historyLoading) return;

    historyLoading = true;

    try {
        const result = await getJSON(API_HISTORY);
        const rows = normalizeRows(result);

        const sortedRows = [...rows].sort((a, b) => {
            const timeA = a?.created_at
                ? new Date(a.created_at).getTime()
                : NaN;

            const timeB = b?.created_at
                ? new Date(b.created_at).getTime()
                : NaN;

            if (Number.isFinite(timeA) && Number.isFinite(timeB)) {
                return timeA - timeB;
            }

            const idA = finiteNumber(a?.id);
            const idB = finiteNumber(b?.id);

            if (idA !== null && idB !== null) {
                return idA - idB;
            }

            return 0;
        });

        const recentRows = sortedRows.slice(-MAX_POINTS);

        updateHistoryChart(charts.gas, recentRows, "gas", "Khí gas");
        updateHistoryChart(charts.light, recentRows, "light", "Ánh sáng");
        updateHistoryChart(charts.smoke, recentRows, "smoke_ugm3", "Chỉ số khói ước tính");
        updateHistoryChart(charts.alcohol, recentRows, "alcohol_ppm", "Hơi cồn ước tính");

        console.log(`[HISTORY] Đã tải ${recentRows.length} bản ghi.`);
    } catch (error) {
        console.error("[HISTORY] Lỗi tải lịch sử:", error);
    } finally {
        historyLoading = false;
    }
}

// ==================================================
// 5. TẢI DỮ LIỆU CẢM BIẾN
// ==================================================

async function loadSensor() {
    try {
        const result = await getJSON(API_SENSOR);

        const sensor =
            result.data && typeof result.data === "object"
                ? result.data
                : result;

        const gas = finiteNumber(sensor.gas);
        const light = finiteNumber(sensor.light);
        const alcohol = finiteNumber(sensor.alcohol_ppm);
        const smoke = finiteNumber(sensor.smoke_ugm3);

        updateGauge(gauges.gas, gas, "Khí gas", 0, 100);
        updateGauge(gauges.light, light, "Ánh sáng", 0, 20000);
        updateGauge(gauges.smoke, smoke, "Chỉ số khói ước tính", 0, 5000);
        updateGauge(gauges.alcohol, alcohol, "Hơi cồn ước tính", 0, 10000);
        updateLiveCharts(gas, light, smoke, alcohol);  
        setText(
            "gasNote",
            gas === null
                ? "Chưa có dữ liệu gas"
                : gas > 35
                    ? `⚠️ Gas ${formatNumber(gas)}% — vượt ngưỡng 35%`
                    : `Gas ${formatNumber(gas)}% — dưới ngưỡng 35%`
        );

        setText(
            "lightNote",
            light === null
                ? "Chưa có dữ liệu ánh sáng"
                : light < 300
                    ? `🌙 ${formatNumber(light)} lux — thiếu sáng`
                    : `☀️ ${formatNumber(light)} lux — đủ sáng`
        );

        setText(
            "alcoholNote",
            alcohol === null
                ? "Chưa có giá trị ước tính hơi cồn"
                : `Giá trị ước tính: ${formatNumber(alcohol, 0)} ppm`
        );

        setText(
            "smokeNote",
            smoke === null
                ? "Chưa có giá trị ước tính khói"
                : `Giá trị ước tính: ${formatNumber(smoke, 0)} µg/m³`
        );

        setText(
            "lastUpdate",
            formatTime(sensor.receivedAt || sensor.created_at || sensor.updatedAt)
        );

        setText("backendState", "Hoạt động");
        setClass("backendState", "state-on");

        console.log("[SENSOR]", {
            gas,
            light,
            alcohol_ppm: alcohol,
            smoke_ugm3: smoke
        });
    } catch (error) {
        console.error("[SENSOR] Không tải được dữ liệu:", error);
        setText("backendState", "Lỗi API");
        setClass("backendState", "state-off");
    }
}

// ==================================================
// 6. CẬP NHẬT GIAO DIỆN CẢNH BÁO KHẨN CẤP
// ==================================================

function updateEmergencyUI() {
    const emergencySwitch = $("emergencySwitch");

    if (emergencySwitch) {
        emergencySwitch.checked = currentEmergency;
        emergencySwitch.disabled = controlBusy || !currentMqttConnected;
    }

    if (pendingEmergency !== null) {
        setText(
            "emergencyState",
            pendingEmergency
                ? "⏳ Đang chờ xác nhận bật cảnh báo"
                : "⏳ Đang chờ xác nhận tắt cảnh báo"
        );

        setClass("emergencyState", "state-unknown");
        setText("emergencyDescription", "Đang chờ trạng thái phản hồi từ ESP32.");
        return;
    }

    if (!currentMqttConnected) {
        setText(
            "emergencyState",
            currentEmergency ? "⚠️ Yêu cầu cảnh báo đang bật" : "Không có kết nối MQTT"
        );

        setClass("emergencyState", "state-unknown");
        setText("emergencyDescription", "Không thể gửi lệnh khi MQTT mất kết nối.");
        setText("emergencyMessage", "⚠️ Kiểm tra backend và broker EMQX.");
        return;
    }

    if (currentEmergency) {
        setText("emergencyState", "🚨 CẢNH BÁO ĐANG BẬT");
        setClass("emergencyState", "state-off");
        setText("emergencyDescription", "Trạng thái cảnh báo được báo về từ backend/thiết bị.");
        setText("emergencyMessage", "Hãy kiểm tra LED và buzzer thực tế.");
    } else {
        setText("emergencyState", "Đang tắt cảnh báo");
        setClass("emergencyState", "state-on");
        setText("emergencyDescription", "Công tắc gửi lệnh cảnh báo qua MQTT.");
        setText("emergencyMessage", "MQTT đã kết nối. Có thể gửi lệnh cảnh báo.");
    }
}

// ==================================================
// 7. TRẠNG THÁI THIẾT BỊ
// ==================================================

function updateDeviceStatus(result) {
    const device = result.device || {};

    currentMode = device.mode === "manual" ? "manual" : "auto";
    currentLed = device.led === true;
    currentBuzzer = device.buzzer === true;
    currentMqttConnected = result.mqttConnected === true;

    const hasDeviceStatus = Boolean(device.updatedAt);

    if (pendingEmergency !== null) {
        const elapsed = Date.now() - pendingEmergencyAt;

        if (
            typeof device.emergency === "boolean" &&
            device.emergency === pendingEmergency
        ) {
            currentEmergency = pendingEmergency;
            pendingEmergency = null;
            pendingEmergencyAt = 0;
            setText("emergencyMessage", "Đã nhận trạng thái khớp với yêu cầu.");
        } else if (elapsed >= EMERGENCY_CONFIRM_TIMEOUT) {
            pendingEmergency = null;
            pendingEmergencyAt = 0;

            if (typeof device.emergency === "boolean") {
                currentEmergency = device.emergency;
            }

            setText(
                "emergencyMessage",
                "⚠️ Chưa nhận xác nhận từ ESP32. Kiểm tra firmware và MQTT."
            );
        } else {
            currentEmergency = pendingEmergency;
        }
    } else if (typeof device.emergency === "boolean") {
        currentEmergency = device.emergency;
    }

    setText("mqttState", currentMqttConnected ? "Đã kết nối" : "Mất kết nối");
    setClass("mqttState", currentMqttConnected ? "state-on" : "state-off");

    setText("connectionBadge", currentMqttConnected ? "● MQTT đã kết nối" : "● MQTT mất kết nối");

    setText("deviceState", hasDeviceStatus ? "Đã nhận trạng thái" : "Chưa nhận trạng thái");
    setClass("deviceState", hasDeviceStatus ? "state-on" : "state-unknown");

    setText("modeState", currentMode === "auto" ? "Tự động" : "Thủ công");
    setClass("modeState", currentMode === "auto" ? "state-on" : "state-unknown");

    setText("ledState", currentLed ? "Đang bật" : "Đang tắt");
    setClass("ledState", currentLed ? "state-on" : "state-off");

    setText("buzzerState", currentBuzzer ? "Đang bật" : "Đang tắt");
    setClass("buzzerState", currentBuzzer ? "state-on" : "state-off");

    const autoButton = $("autoModeButton");
    const manualButton = $("manualModeButton");
    const ledSwitch = $("ledSwitch");
    const buzzerSwitch = $("buzzerSwitch");

    if (autoButton) {
        autoButton.classList.toggle("active", currentMode === "auto");
        autoButton.disabled = controlBusy || !currentMqttConnected;
    }

    if (manualButton) {
        manualButton.classList.toggle("active", currentMode === "manual");
        manualButton.disabled = controlBusy || !currentMqttConnected;
    }

    if (ledSwitch) {
        ledSwitch.checked = currentLed;
        ledSwitch.disabled = controlBusy || !currentMqttConnected || currentMode !== "manual";
    }

    if (buzzerSwitch) {
        buzzerSwitch.checked = currentBuzzer;
        buzzerSwitch.disabled = controlBusy || !currentMqttConnected || currentMode !== "manual";
    }

    setText(
        "ledDescription",
        currentMode === "auto"
            ? "Đèn tự động theo ngưỡng ánh sáng"
            : "Bạn có thể bật/tắt đèn bằng công tắc"
    );

    setText(
        "buzzerDescription",
        currentMode === "auto"
            ? "Còi tự động khi gas vượt 35%"
            : "Bạn có thể bật/tắt còi bằng công tắc"
    );

    if (pendingEmergency !== null) {
        setText("controlMessage", "Đang chờ xác nhận trạng thái cảnh báo.");
    } else {
        setText(
            "controlMessage",
            currentMode === "auto"
                ? "Chế độ tự động: đèn và còi hoạt động theo ngưỡng cảm biến."
                : "Chế độ thủ công: bạn điều khiển đèn và còi bằng công tắc."
        );
    }

    updateEmergencyUI();
}

// ==================================================
// 8. TẢI TRẠNG THÁI BACKEND
// ==================================================

async function loadStatus() {
    try {
        const result = await getJSON(API_STATUS);
        updateDeviceStatus(result);
    } catch (error) {
        console.error("[STATUS] Không tải được trạng thái:", error);

        currentMqttConnected = false;

        setText("connectionBadge", "Không kết nối được backend");
        setText("backendState", "Lỗi kết nối");
        setClass("backendState", "state-off");

        setText("mqttState", "Không rõ");
        setClass("mqttState", "state-unknown");

        setText("deviceState", "Không rõ");
        setClass("deviceState", "state-unknown");

        for (const id of [
            "autoModeButton",
            "manualModeButton",
            "ledSwitch",
            "buzzerSwitch",
            "emergencySwitch"
        ]) {
            const element = $(id);
            if (element) element.disabled = true;
        }

        updateEmergencyUI();
    }
}

// ==================================================
// 9. ĐIỀU KHIỂN THIẾT BỊ
// ==================================================

async function sendControl(command) {
    if (controlBusy) return;

    controlBusy = true;
    setText("controlMessage", "Đang gửi lệnh đến backend...");

    for (const id of [
        "autoModeButton",
        "manualModeButton",
        "ledSwitch",
        "buzzerSwitch",
        "emergencySwitch"
    ]) {
        const element = $(id);
        if (element) element.disabled = true;
    }

    try {
        const result = await getJSON(API_CONTROL, {
            method: "POST",
            body: JSON.stringify(command)
        });

        setText(
            "controlMessage",
            result.message || "Backend đã nhận lệnh điều khiển."
        );

        console.log("[CONTROL]", command, result);

        await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
        console.error("[CONTROL] Gửi lệnh thất bại:", error);
        setText("controlMessage", `Không gửi được lệnh: ${error.message}`);
    } finally {
        controlBusy = false;
        await loadStatus();
    }
}

function setAutoMode() {
    sendControl({ mode: "auto" });
}

function setManualMode() {
    sendControl({
        mode: "manual",
        led: currentLed,
        buzzer: currentBuzzer
    });
}

function toggleLed() {
    const ledSwitch = $("ledSwitch");

    if (!ledSwitch || currentMode !== "manual" || controlBusy) {
        return;
    }

    sendControl({
        mode: "manual",
        led: ledSwitch.checked,
        buzzer: currentBuzzer
    });
}

function toggleBuzzer() {
    const buzzerSwitch = $("buzzerSwitch");

    if (!buzzerSwitch || currentMode !== "manual" || controlBusy) {
        return;
    }

    sendControl({
        mode: "manual",
        led: currentLed,
        buzzer: buzzerSwitch.checked
    });
}

// ==================================================
// 10. CẢNH BÁO KHẨN CẤP
// ==================================================

async function toggleEmergency() {
    const emergencySwitch = $("emergencySwitch");

    if (!emergencySwitch || controlBusy) return;

    const requestedState = emergencySwitch.checked;

    if (!currentMqttConnected) {
        emergencySwitch.checked = currentEmergency;
        setText("emergencyMessage", "⚠️ MQTT mất kết nối. Không thể gửi lệnh.");
        return;
    }

    pendingEmergency = requestedState;
    pendingEmergencyAt = Date.now();
    currentEmergency = requestedState;

    controlBusy = true;

    emergencySwitch.checked = requestedState;
    emergencySwitch.disabled = true;

    setText(
        "emergencyState",
        requestedState
            ? "⏳ Đang chờ xác nhận bật cảnh báo"
            : "⏳ Đang chờ xác nhận tắt cảnh báo"
    );

    setClass("emergencyState", "state-unknown");
    setText("emergencyDescription", "Đang gửi yêu cầu qua MQTT và chờ phản hồi.");

    setText(
        "emergencyMessage",
        requestedState
            ? "Đang gửi yêu cầu bật cảnh báo..."
            : "Đang gửi yêu cầu tắt cảnh báo..."
    );

    try {
        const result = await getJSON(API_EMERGENCY, {
            method: "POST",
            body: JSON.stringify({
                enabled: requestedState
            })
        });

        console.log("[EMERGENCY] Backend phản hồi:", result);

        setText(
            "emergencyMessage",
            result.message
                ? `${result.message}. Đang chờ ESP32 xác nhận.`
                : "Đã gửi lệnh. Đang chờ ESP32 xác nhận."
        );
    } catch (error) {
        console.error("[EMERGENCY] Lỗi:", error);

        pendingEmergency = null;
        pendingEmergencyAt = 0;

        setText("emergencyMessage", `❌ Gửi lệnh thất bại: ${error.message}`);

        await loadStatus();
    } finally {
        controlBusy = false;
        await loadStatus();
    }
}

// Gắn hàm vào window để các nút onclick trong HTML gọi được.
window.setAutoMode = setAutoMode;
window.setManualMode = setManualMode;
window.toggleLed = toggleLed;
window.toggleBuzzer = toggleBuzzer;
window.toggleEmergency = toggleEmergency;

// ==================================================
// 11. ĐIỀU CHỈNH KÍCH THƯỚC
// ==================================================

function resizeAllCharts() {
    Object.values(gauges).forEach(chart => {
        if (chart) chart.resize();
    });

    Object.values(charts).forEach(chart => {
        if (chart) chart.resize();
    });
}

// Khởi tạo sau khi trình duyệt đã bố trí xong HTML/CSS.
async function startDashboard() {
    if (dashboardStarted) return;
    dashboardStarted = true;

    if (typeof echarts === "undefined") {
        setText("connectionBadge", "Không tải được thư viện biểu đồ");
        setText("backendState", "Chưa khởi tạo");
        console.error("[START] ECharts chưa tải được.");
        dashboardStarted = false;
        return;
    }

    // Đợi một frame để HTML/CSS xác định kích thước.
    await new Promise(resolve => requestAnimationFrame(resolve));

    initGauges();
    initCharts();

    // Đợi thêm một frame rồi resize các instance.
    await new Promise(resolve => requestAnimationFrame(resolve));
    resizeAllCharts();

    await Promise.allSettled([
        loadSensor(),
        loadStatus(),
        loadHistory()
    ]);

   setInterval(loadSensor, SENSOR_INTERVAL);
setInterval(loadStatus, STATUS_INTERVAL);
    console.log("[START] Smart4 Dashboard đã khởi động.");
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startDashboard, { once: true });
} else {
    startDashboard();
}

document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;

    requestAnimationFrame(resizeAllCharts);

    loadSensor();
    loadStatus();
    loadHistory();
});

window.addEventListener("resize", function () {
    requestAnimationFrame(resizeAllCharts);
});
