db.run(`
    CREATE TABLE IF NOT EXISTS sensor_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        temp REAL,
        gas REAL,
        light REAL,
        temp_alert INTEGER,
        gas_alert INTEGER
    )
`, (err) => {
    if (err) {
        console.error("❌ Lỗi tạo bảng:", err.message);
    } else {
        console.log("✅ Bảng sensor_data đã sẵn sàng");
    }
});
