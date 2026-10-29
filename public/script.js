"use strict";

// ==================================================
// SMART4 DASHBOARD
// GAS - LIGHT - ALCOHOL - SMOKE - EMERGENCY
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

// Trạng thái cảnh báo đang chờ ESP32 xác nhận.
let pendingEmergency = null;
let pendingEmergencyAt = 0;

const gauges = {};
const charts = {};

// ==================================================
// CÁC HÀM TIỆN ÍCH
// ==================================================

function $(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    const element = $(id);

    if (element) {
        element.textContent = value;
    }
}

function setClass(id, className) {
    const element = $(id);

    if (element) {
        element.className = className;
    }
}

function finiteNumber(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
}

function formatNumber(value, digits = 1) {
    if (value === null || value === undefined) {
        return "--";
    }

    return Number(value).toLocaleString("vi-VN", {
        maximumFractionDigits: digits
    });
}

function formatTime(value) {
    if (!value) {
        return "--";
    }

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
    if (Array.isArray(result)) {
        return result;
    }

    if (Array.isArray(result?.data)) {
        return result.data;
    }

    if (Array.isArray(result?.history)) {
        return result.history;
    }

    if (Array.isArray(result?.rows)) {
        return result.rows;
    }

    return [];
}

// ==================================================
// 1. ĐỒNG HỒ CẢM BIẾN
// ==================================================

function createGauge(elementId, title, unit, min, max) {
    const element = $(elementId);

    if (!element || typeof echarts === "undefined") {
        console.warn(`Không tìm thấy đồng hồ: ${elementId}`);
        return null;
    }

    const chart =
        echarts.getInstanceByDom(element) || echarts.init(element);

    chart.setOption({
        animationDuration: 250,

        series: [{
            type: "gauge",
            min,
            max,
            startAngle: 210,
            endAngle: -30,
            center: ["50%", "55%"],
            radius: "90%",

            progress: {
                show: true,
                width: 13
            },

            axisLine: {
                lineStyle: {
                    width: 13,
                    color: [[1, "#293548"]]
                }
            },

            pointer: {
                show: true,
                length: "58%",
                width: 4
            },

            axisTick: {
                distance: -18,
                length: 4,
                lineStyle: {
                    color: "#94a3b8"
                }
            },

            splitLine: {
                distance: -19,
                length: 9,
                lineStyle: {
                    color: "#cbd5e1",
                    width: 2
                }
            },

            axisLabel: {
                distance: 15,
                color: "#94a3b8",
                fontSize: 10
            },

            anchor: {
                show: true,
                showAbove: true,
                size: 8
            },

            title: {
                show: true,
                offsetCenter: [0, "63%"],
                color: "#94a3b8",
                fontSize: 12
            },

            detail: {
                show: true,
                valueAnimation: true,
                offsetCenter: [0, "28%"],
                fontSize: 19,
                fontWeight: "bold",
                color: "#f8fafc",

                formatter(value) {
                    return `${formatNumber(value)} ${unit}`;
                }
            },

            data: [{
                value: min,
                name: title
            }]
        }]
    });

    return chart;
}

function updateGauge(chart, value, title, min, max) {
    if (!chart || value === null) {
        return;
    }

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
    gauges.gas = createGauge(
        "gasGauge", "Khí gas", "%", 0, 100
    );

    gauges.light = createGauge(
        "lightGauge", "Ánh sáng", "lux", 0, 20000
    );

    gauges.alcohol = createGauge(
        "alcoholGauge", "Hơi cồn", "ppm", 0, 10000
    );

    gauges.smoke = createGauge(
        "smokeGauge", "Chỉ số khói", "µg/m³", 0, 5000
    );
}

// ==================================================
// 2. BIỂU ĐỒ LỊCH SỬ
// ==================================================

function createLineChart(elementId, title, unit) {
    const element = $(elementId);

    if (!element || typeof echarts === "undefined") {
        console.warn(`Không tìm thấy biểu đồ: ${elementId}`);
        return null;
    }

    const chart =
        echarts.getInstanceByDom(element) || echarts.init(element);

    chart.setOption({
        backgroundColor: "transparent",
        animationDuration: 250,

        tooltip: {
            trigger: "axis",

            formatter(params) {
                if (!params?.length) {
                    return "";
                }

                const item = params[0];
                const value = finiteNumber(item.value);

                return `${item.axisValue}<br>${title}: ${
                    value === null
                        ? "Không có dữ liệu"
                        : `${formatNumber(value)} ${unit}`
                }`;
            }
        },

        grid: {
            left: 70,
            right: 20,
            top: 25,
            bottom: 45,
            containLabel: false
        },

        xAxis: {
            type: "category",
            data: [],
            boundaryGap: false,

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
                    color: "#293548"
                }
            }
        },

        series: [{
            name: title,
            type: "line",
            data: [],
            smooth: 0.2,
            connectNulls: false,
            showSymbol: true,
            symbol: "circle",
            symbolSize: 4,

            lineStyle: {
                width: 3
            },

            areaStyle: {
                opacity: 0.08
            }
        }],

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
    });

    return chart;
}

function initCharts() {
    charts.gas = createLineChart(
        "gasChart", "Khí gas", "%"
    );

    charts.light = createLineChart(
        "lightChart", "Ánh sáng", "lux"
    );

    charts.alcohol = createLineChart(
        "alcoholChart", "Hơi cồn", "ppm"
    );

    charts.smoke = createLineChart(
        "smokeChart", "Chỉ số khói", "µg/m³"
    );
}

function historyLabel(row, index) {
    if (row?.created_at) {
        const time = formatTime(row.created_at);

        if (time !== "--") {
            return time;
        }
    }

    if (row?.id !== undefined && row?.id !== null) {
        return `ID ${row.id}`;
    }

    return `Mẫu ${index + 1}`;
}

function updateHistoryChart(chart, rows, field, title) {
    if (!chart) {
        return;
    }

    const validRows = rows
        .map((row, index) => ({
            row,
            index,
            value: finiteNumber(row?.[field])
        }))
        .filter(item => item.value !== null);

    const labels = validRows.map(item =>
        historyLabel(item.row, item.index)
    );

    const values = validRows.map(item => item.value);

    chart.setOption({
        xAxis: {
            data: labels
        },

        series: [{
            name: title,
            data: values
        }],

        graphic: [{
            type: "text",
            left: "center",
            top: "middle",
            silent: true,

            style: {
                text: values.length
                    ? ""
                    : "Chưa có dữ liệu lịch sử",
                fill: "#94a3b8",
                fontSize: 13
            }
        }]
    });

    chart.resize();
}

async function loadHistory() {
    if (historyLoading) {
        return;
    }

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

            if (
                Number.isFinite(timeA) &&
                Number.isFinite(timeB)
            ) {
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

        updateHistoryChart(
            charts.gas, recentRows, "gas", "Khí gas"
        );

        updateHistoryChart(
            charts.light, recentRows, "light", "Ánh sáng"
        );

        updateHistoryChart(
            charts.alcohol,
            recentRows,
            "alcohol_ppm",
            "Hơi cồn"
        );

        updateHistoryChart(
            charts.smoke,
            recentRows,
            "smoke_ugm3",
            "Chỉ số khói"
        );

        console.log(
            `[HISTORY] Đã tải ${recentRows.length} bản ghi.`
        );
    } catch (error) {
        console.error(
            "[HISTORY] Lỗi tải lịch sử:",
            error
        );
    } finally {
        historyLoading = false;
    }
}

// ==================================================
// 3. DỮ LIỆU CẢM BIẾN
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

        updateGauge(
            gauges.gas, gas, "Khí gas", 0, 100
        );

        updateGauge(
            gauges.light, light, "Ánh sáng", 0, 20000
        );

        updateGauge(
            gauges.alcohol, alcohol, "Hơi cồn", 0, 10000
        );

        updateGauge(
            gauges.smoke, smoke, "Chỉ số khói", 0, 5000
        );

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
                    ? `🌙 ${formatNumber(light)} — thiếu sáng`
                    : `☀️ ${formatNumber(light)} — đủ sáng`
        );

        setText(
            "alcoholNote",
            alcohol === null
                ? "Đang chờ dữ liệu hơi cồn"
                : `Chỉ số hơi cồn: ${formatNumber(alcohol, 0)} ppm`
        );

        setText(
            "smokeNote",
            smoke === null
                ? "Đang chờ dữ liệu khói"
                : `Chỉ số khói: ${formatNumber(smoke, 0)} µg/m³`
        );

        setText(
            "lastUpdate",
            formatTime(
                sensor.receivedAt ||
                sensor.created_at ||
                sensor.updatedAt
            )
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
        console.error(
            "[SENSOR] Không tải được dữ liệu:",
            error
        );

        setText("backendState", "Lỗi API");
        setClass("backendState", "state-off");
    }
}

// ==================================================
// 4. CẬP NHẬT GIAO DIỆN CẢNH BÁO
// ==================================================

function updateEmergencyUI() {
    const emergencySwitch = $("emergencySwitch");

    if (emergencySwitch) {
        emergencySwitch.checked = currentEmergency;

        emergencySwitch.disabled =
            controlBusy || !currentMqttConnected;
    }

    if (pendingEmergency !== null) {
        setText(
            "emergencyState",
            pendingEmergency
                ? "⏳ Đang chờ xác nhận bật cảnh báo"
                : "⏳ Đang chờ xác nhận tắt cảnh báo"
        );

        setClass("emergencyState", "state-unknown");

        setText(
            "emergencyDescription",
            "Đã ghi nhận yêu cầu của bạn. Hệ thống đang chờ phản hồi từ ESP32."
        );

        // Không ghi đè thông báo chờ xác nhận.
        // Chỉ thông báo trạng thái, không khẳng định còi/LED đã hoạt động.
        return;
    }

    if (!currentMqttConnected) {
        setText(
            "emergencyState",
            currentEmergency
                ? "⚠️ Yêu cầu cảnh báo đang bật"
                : "Không có kết nối MQTT"
        );

        setClass("emergencyState", "state-unknown");

        setText(
            "emergencyDescription",
            "Không thể gửi lệnh khi MQTT mất kết nối."
        );

        setText(
            "emergencyMessage",
            "⚠️ Mất kết nối MQTT. Hãy kiểm tra backend và broker EMQX."
        );

        return;
    }

    if (currentEmergency) {
        setText(
            "emergencyState",
            "🚨 CẢNH BÁO ĐANG BẬT"
        );

        setClass("emergencyState", "state-off");

        setText(
            "emergencyDescription",
            "Trạng thái cảnh báo được báo về từ backend/thiết bị."
        );

        setText(
            "emergencyMessage",
            "Hãy kiểm tra LED và buzzer thực tế. Trạng thái trên website không tự chứng minh thiết bị cảnh báo đã hoạt động."
        );
    } else {
        setText(
            "emergencyState",
            "Đang tắt cảnh báo"
        );

        setClass("emergencyState", "state-on");

        setText(
            "emergencyDescription",
            "Công tắc gửi lệnh bật/tắt cảnh báo qua MQTT."
        );

        setText(
            "emergencyMessage",
            "MQTT đã kết nối. Có thể gửi lệnh cảnh báo đến backend."
        );
    }
}

// ==================================================
// 5. TRẠNG THÁI THIẾT BỊ
// ==================================================

function updateDeviceStatus(result) {
    const device = result.device || {};

    currentMode =
        device.mode === "manual" ? "manual" : "auto";

    currentLed = device.led === true;
    currentBuzzer = device.buzzer === true;
    currentMqttConnected = result.mqttConnected === true;

    const hasDeviceStatus = Boolean(device.updatedAt);

    // Chỉ cập nhật emergency khi không có lệnh đang chờ.
    // Điều này ngăn status polling ghi đè công tắc vừa bật.
    if (pendingEmergency !== null) {
        const elapsed = Date.now() - pendingEmergencyAt;

        if (
            typeof device.emergency === "boolean" &&
            device.emergency === pendingEmergency
        ) {
            // Nhận được trạng thái khớp với yêu cầu.
            currentEmergency = pendingEmergency;
            pendingEmergency = null;
            pendingEmergencyAt = 0;

            setText(
                "emergencyMessage",
                "Đã nhận trạng thái khớp với yêu cầu từ backend."
            );
        } else if (elapsed >= EMERGENCY_CONFIRM_TIMEOUT) {
            // Không được khẳng định thiết bị đã thực hiện lệnh.
            pendingEmergency = null;
            pendingEmergencyAt = 0;

            // Đồng bộ lại trạng thái cuối cùng backend đang báo.
            if (typeof device.emergency === "boolean") {
                currentEmergency = device.emergency;
            }

            setText(
                "emergencyMessage",
                "⚠️ Chưa nhận được xác nhận từ ESP32. Kiểm tra firmware và topic MQTT."
            );
        } else {
            // Giữ trạng thái yêu cầu trong thời gian chờ.
            currentEmergency = pendingEmergency;
        }
    } else if (typeof device.emergency === "boolean") {
        currentEmergency = device.emergency;
    }

    setText(
        "mqttState",
        currentMqttConnected ? "Đã kết nối" : "Mất kết nối"
    );

    setClass(
        "mqttState",
        currentMqttConnected ? "state-on" : "state-off"
    );

    setText(
        "connectionBadge",
        currentMqttConnected
            ? "● MQTT đã kết nối"
            : "● MQTT mất kết nối"
    );

    setText(
        "deviceState",
        hasDeviceStatus
            ? "Đã nhận trạng thái"
            : "Chưa nhận trạng thái"
    );

    setClass(
        "deviceState",
        hasDeviceStatus ? "state-on" : "state-unknown"
    );

    setText(
        "modeState",
        currentMode === "auto" ? "Tự động" : "Thủ công"
    );

    setClass(
        "modeState",
        currentMode === "auto" ? "state-on" : "state-unknown"
    );

    setText(
        "ledState",
        currentLed ? "Đang bật" : "Đang tắt"
    );

    setClass(
        "ledState",
        currentLed ? "state-on" : "state-off"
    );

    setText(
        "buzzerState",
        currentBuzzer ? "Đang bật" : "Đang tắt"
    );

    setClass(
        "buzzerState",
        currentBuzzer ? "state-on" : "state-off"
    );

    const autoButton = $("autoModeButton");
    const manualButton = $("manualModeButton");
    const ledSwitch = $("ledSwitch");
    const buzzerSwitch = $("buzzerSwitch");

    if (autoButton) {
        autoButton.classList.toggle(
            "active",
            currentMode === "auto"
        );

        autoButton.disabled =
            controlBusy || !currentMqttConnected;
    }

    if (manualButton) {
        manualButton.classList.toggle(
            "active",
            currentMode === "manual"
        );

        manualButton.disabled =
            controlBusy || !currentMqttConnected;
    }

    if (ledSwitch) {
        ledSwitch.checked = currentLed;

        ledSwitch.disabled =
            controlBusy ||
            !currentMqttConnected ||
            currentMode !== "manual";
    }

    if (buzzerSwitch) {
        buzzerSwitch.checked = currentBuzzer;

        buzzerSwitch.disabled =
            controlBusy ||
            !currentMqttConnected ||
            currentMode !== "manual";
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
        setText(
            "controlMessage",
            "Đang chờ xác nhận trạng thái cảnh báo."
        );
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
// 6. TẢI TRẠNG THÁI BACKEND
// ==================================================

async function loadStatus() {
    try {
        const result = await getJSON(API_STATUS);

        updateDeviceStatus(result);
    } catch (error) {
        console.error(
            "[STATUS] Không tải được trạng thái:",
            error
        );

        currentMqttConnected = false;

        setText(
            "connectionBadge",
            "Không kết nối được backend"
        );

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

            if (element) {
                element.disabled = true;
            }
        }

        updateEmergencyUI();
    }
}

// ==================================================
// 7. ĐIỀU KHIỂN AUTO / MANUAL / LED / BUZZER
// ==================================================

async function sendControl(command) {
    if (controlBusy) {
        return;
    }

    controlBusy = true;

    setText(
        "controlMessage",
        "Đang gửi lệnh đến backend..."
    );

    for (const id of [
        "autoModeButton",
        "manualModeButton",
        "ledSwitch",
        "buzzerSwitch",
        "emergencySwitch"
    ]) {
        const element = $(id);

        if (element) {
            element.disabled = true;
        }
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

        setText(
            "controlMessage",
            `Không gửi được lệnh: ${error.message}`
        );
    } finally {
        controlBusy = false;
        await loadStatus();
    }
}

// ==================================================
// 8. CẢNH BÁO SIÊU NGUY HIỂM
// ==================================================

async function toggleEmergency() {
    const emergencySwitch = $("emergencySwitch");

    if (!emergencySwitch || controlBusy) {
        return;
    }

    const requestedState = emergencySwitch.checked;

    if (!currentMqttConnected) {
        emergencySwitch.checked = currentEmergency;

        setText(
            "emergencyMessage",
            "⚠️ MQTT mất kết nối. Không thể gửi lệnh."
        );

        return;
    }

    // Đặt trạng thái đang chờ trước khi gửi lệnh.
    // Polling trạng thái không được phép tắt công tắc ngay lập tức.
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

    setText(
        "emergencyDescription",
        "Đang gửi yêu cầu qua MQTT và chờ phản hồi."
    );

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

        setText(
            "emergencyMessage",
            `❌ Gửi lệnh thất bại: ${error.message}`
        );

        await loadStatus();
    } finally {
        controlBusy = false;
        await loadStatus();
    }
}

function setAutoMode() {
    sendControl({
        mode: "auto"
    });
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

    if (
        !ledSwitch ||
        currentMode !== "manual" ||
        controlBusy
    ) {
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

    if (
        !buzzerSwitch ||
        currentMode !== "manual" ||
        controlBusy
    ) {
        return;
    }

    sendControl({
        mode: "manual",
        led: currentLed,
        buzzer: buzzerSwitch.checked
    });
}

// Công khai các hàm để HTML gọi được.
window.setAutoMode = setAutoMode;
window.setManualMode = setManualMode;
window.toggleLed = toggleLed;
window.toggleBuzzer = toggleBuzzer;
window.toggleEmergency = toggleEmergency;

// ==================================================
// 9. KHỞI ĐỘNG DASHBOARD
// ==================================================

document.addEventListener("DOMContentLoaded", async function () {
    if (typeof echarts === "undefined") {
        setText(
            "connectionBadge",
            "Không tải được thư viện biểu đồ"
        );

        setText("backendState", "Chưa khởi tạo");

        console.error("ECharts chưa tải được.");

        return;
    }

    initGauges();
    initCharts();

    await Promise.allSettled([
        loadSensor(),
        loadStatus(),
        loadHistory()
    ]);

    setInterval(loadSensor, SENSOR_INTERVAL);
    setInterval(loadStatus, STATUS_INTERVAL);
    setInterval(loadHistory, HISTORY_INTERVAL);

    console.log("Smart4 Dashboard đã khởi động.");
});

// ==================================================
// 10. THAY ĐỔI KÍCH THƯỚC BIỂU ĐỒ
// ==================================================

function resizeAllCharts() {
    Object.values(gauges).forEach(chart => {
        if (chart) {
            chart.resize();
        }
    });

    Object.values(charts).forEach(chart => {
        if (chart) {
            chart.resize();
        }
    });
}

document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
        return;
    }

    resizeAllCharts();

    loadSensor();
    loadStatus();
    loadHistory();
});

window.addEventListener("resize", resizeAllCharts);