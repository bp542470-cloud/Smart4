
// =====================================================
// BIẾN TOÀN CỤC
// =====================================================

let lichSu = [];

let lightHistoryChart;
let gasHistoryChart;

let autoMode = false;

// Dữ liệu AUTO
let autoGas = 30;
let autoLight = 2500;

// Mật khẩu AUTO
const AUTO_PASSWORD = "1234";

// =====================================================
// NGƯỠNG HỆ THỐNG
// =====================================================

// Gas > 35% -> cảnh báo
const GAS_ALARM = 35;

// Ánh sáng < 300 lux -> trời tối, bật đèn
const LIGHT_THRESHOLD = 300;


// =====================================================
// BẬT / TẮT AUTO
// =====================================================

function toggleAutoMode() {

    // -----------------------------------------
    // Nếu AUTO đang bật -> tắt AUTO
    // -----------------------------------------

    if (autoMode) {

        autoMode = false;

        const btn =
            document.getElementById("autoModeBtn");

        const mode =
            document.getElementById("modeStatus");

        const connection =
            document.getElementById("connectionStatus");

        btn.innerText = "AUTO: OFF";

        btn.classList.remove("auto-on");

        btn.classList.add("auto-off");

        mode.innerText =
            "MANUAL - Điều khiển từ Wokwi";

        connection.innerText =
            "● Server đang hoạt động";

        return;
    }


    // -----------------------------------------
    // Nhập mật khẩu để bật AUTO
    // -----------------------------------------

    const password =
        prompt("🔐 Nhập mật khẩu để bật chế độ AUTO:");

    if (password === null) {
        return;
    }


    // -----------------------------------------
    // Kiểm tra mật khẩu
    // -----------------------------------------

    if (password !== AUTO_PASSWORD) {

        alert(
            "❌ Sai mật khẩu! Không thể bật AUTO."
        );

        return;
    }


    // -----------------------------------------
    // Bật AUTO
    // -----------------------------------------

    autoMode = true;

    const btn =
        document.getElementById("autoModeBtn");

    const mode =
        document.getElementById("modeStatus");

    const connection =
        document.getElementById("connectionStatus");

    btn.innerText = "AUTO: ON";

    btn.classList.remove("auto-off");

    btn.classList.add("auto-on");

    mode.innerText =
        "AUTO - Web tự động thay đổi dữ liệu";

    connection.innerText =
        "● AUTO - Dữ liệu mô phỏng trên Web";
}


// =====================================================
// TẠO DỮ LIỆU AUTO
// =====================================================

function taoDuLieuAuto() {

    // Gas thay đổi ngẫu nhiên
    autoGas +=
        (Math.random() - 0.5) * 20;

    // Ánh sáng thay đổi ngẫu nhiên
    autoLight +=
        (Math.random() - 0.5) * 1000;


    // Giới hạn Gas
    autoGas =
        Math.max(
            0,
            Math.min(
                100,
                autoGas
            )
        );


    // Giới hạn ánh sáng
    autoLight =
        Math.max(
            0,
            Math.min(
                5000,
                autoLight
            )
        );


    return {
        gas: autoGas,
        light: autoLight
    };
}


// =====================================================
// CẬP NHẬT DỮ LIỆU
// =====================================================

async function capNhatDuLieu() {

    let gas;
    let light;


    // =================================================
    // AUTO
    // =================================================

    if (autoMode) {

        const data =
            taoDuLieuAuto();

        gas =
            data.gas;

        light =
            data.light;
    }


    // =================================================
    // MANUAL - LẤY DỮ LIỆU TỪ SERVER
    // =================================================

    else {

        try {

            const response =
                await fetch("/api/sensor");


            if (!response.ok) {

                throw new Error(
                    "API lỗi"
                );
            }


            const data =
                await response.json();


            gas =
                Number(data.gas);

            light =
                Number(data.light);


            document
                .getElementById(
                    "connectionStatus"
                )
                .innerText =
                "● Server đang hoạt động";
        }


        catch (error) {

            console.error(error);

            document
                .getElementById(
                    "connectionStatus"
                )
                .innerText =
                "● Không kết nối được Server";

            return;
        }
    }


    // =================================================
    // HIỂN THỊ GIÁ TRỊ
    // =================================================

    document
        .getElementById("lightValue")
        .innerText =
        light.toFixed(1) + " lux";


    document
        .getElementById("gasValue")
        .innerText =
        gas.toFixed(1) + " %";


    // =================================================
    // TRẠNG THÁI ÁNH SÁNG
    // =================================================

    const lightStatus =
        document.getElementById(
            "lightStatus"
        );


    // -----------------------------------------
    // LUX < 300
    // -----------------------------------------

    if (light < LIGHT_THRESHOLD) {

        lightStatus.innerText =
            "🌙 Trời tối - Đèn đang bật";

        lightStatus.style.color =
            "#facc15";
    }


    // -----------------------------------------
    // LUX >= 300
    // -----------------------------------------

    else {

        lightStatus.innerText =
            "☀️ Ánh sáng bình thường - Đèn tắt";

        lightStatus.style.color =
            "#22c55e";
    }


    // =================================================
    // TRẠNG THÁI GAS
    // =================================================

    const gasStatus =
        document.getElementById(
            "gasStatus"
        );


    if (gas > GAS_ALARM) {

        // Gas > 35%

        gasStatus.innerText =
            "🔴 CẢNH BÁO GAS CAO";

        gasStatus.style.color =
            "#ef4444";
    }

    else {

        // Gas <= 35%

        gasStatus.innerText =
            "🟢 An toàn";

        gasStatus.style.color =
            "#22c55e";
    }


    // =================================================
    // LƯU LỊCH SỬ
    // =================================================

    lichSu.push({

        time:
            new Date()
                .toLocaleTimeString(
                    "vi-VN"
                ),

        light:
            light,

        gas:
            gas
    });


    // Chỉ giữ 30 dữ liệu gần nhất
    if (lichSu.length > 30) {

        lichSu.shift();
    }


    // =================================================
    // VẼ GAUGE
    // =================================================

    veGauge(
        "lightChart",
        light,
        5000,
        "lux"
    );


    veGauge(
        "gasChart",
        gas,
        100,
        "%"
    );


    // =================================================
    // VẼ BIỂU ĐỒ
    // =================================================

    veLichSu();
}


// =====================================================
// VẼ GAUGE
// =====================================================

function veGauge(
    id,
    value,
    max,
    donVi
) {

    const element =
        document.getElementById(id);


    if (!element) {
        return;
    }


    // Tính phần trăm vòng tròn
    let percent =
        (value / max) * 100;


    percent =
        Math.max(
            0,
            Math.min(
                100,
                percent
            )
        );


    element.innerHTML = `

        <div style="
            width:220px;
            height:220px;
            border-radius:50%;
            margin:auto;
            display:flex;
            align-items:center;
            justify-content:center;

            background:conic-gradient(
                #22c55e ${percent}%,
                #374151 ${percent}%
            );
        ">

            <div style="
                width:170px;
                height:170px;
                border-radius:50%;
                background:#1f2937;

                display:flex;
                flex-direction:column;

                align-items:center;
                justify-content:center;
            ">

                <div style="
                    font-size:32px;
                    font-weight:bold;
                    color:white;
                ">

                    ${Number(value).toFixed(1)}

                </div>


                <div style="
                    font-size:18px;
                    color:#d1d5db;
                ">

                    ${donVi}

                </div>

            </div>

        </div>
    `;
}


// =====================================================
// VẼ LỊCH SỬ
// =====================================================

function veLichSu() {

    const lightElement =
        document.getElementById(
            "lightHistoryChart"
        );


    const gasElement =
        document.getElementById(
            "gasHistoryChart"
        );


    if (!lightElement || !gasElement) {
        return;
    }


    // =================================================
    // BIỂU ĐỒ ÁNH SÁNG
    // =================================================

    if (!lightHistoryChart) {

        lightHistoryChart =
            echarts.init(
                lightElement
            );
    }


    lightHistoryChart.setOption({

        tooltip: {
            trigger: "axis"
        },


        xAxis: {

            type: "category",

            data:
                lichSu.map(
                    item => item.time
                )
        },


        yAxis: {

            type: "value",

            name: "Lux"
        },


        series: [{

            name: "Ánh sáng",

            type: "line",

            smooth: true,

            data:
                lichSu.map(
                    item => item.light
                )
        }]
    });


    // =================================================
    // BIỂU ĐỒ GAS
    // =================================================

    if (!gasHistoryChart) {

        gasHistoryChart =
            echarts.init(
                gasElement
            );
    }


    gasHistoryChart.setOption({

        tooltip: {
            trigger: "axis"
        },


        xAxis: {

            type: "category",

            data:
                lichSu.map(
                    item => item.time
                )
        },


        yAxis: {

            type: "value",

            name: "%"
        },


        series: [{

            name: "Gas",

            type: "line",

            smooth: true,

            data:
                lichSu.map(
                    item => item.gas
                )
        }]
    });
}


// =====================================================
// TẢI LỊCH SỬ TỪ MYSQL
// =====================================================

async function taiLichSu() {

    try {

        const response =
            await fetch(
                "/api/history"
            );


        const data =
            await response.json();


        lichSu =
            data.map(
                item => ({

                    time:
                        new Date(
                            item.created_at
                        ).toLocaleTimeString(
                            "vi-VN"
                        ),

                    light:
                        Number(
                            item.light
                        ),

                    gas:
                        Number(
                            item.gas
                        )
                })
            );


        veLichSu();
    }


    catch (error) {

        console.error(
            "Lỗi lịch sử:",
            error
        );
    }
}


// =====================================================
// KHỞI ĐỘNG WEB
// =====================================================

taiLichSu();

capNhatDuLieu();


// Cập nhật mỗi 1 giây
setInterval(
    capNhatDuLieu,
    1000
);

