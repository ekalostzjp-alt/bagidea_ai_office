// hooks/anomaly.sample.js — ตัวอย่างจุดเสียบ "anomaly" (เจ้าภาพเฟสถัดไป: น้องไวท์ / AI).
// เปิดใช้จริง: คัดลอกเป็น hooks/anomaly.js (loader ข้าม *.sample.js).
// หน้าที่: ตรวจ "ผิดปกติเชิงสถิติ/พฤติกรรม" จาก metrics — baseline, spike, trend, หรือเรียก AI.
module.exports = {
  id: "anomaly",
  async analyze(snapshot, api) {
    const anomalies = [];
    const now = snapshot.ts || api.now;

    // ตัวอย่างกฎง่ายๆ (placeholder): clients พุ่งเกิน baseline แบบหยาบ
    const m = (snapshot.metrics || []).find((x) => x.key === "daemon.clients");
    if (m && Number(m.value) > 20) {
      anomalies.push({
        id: "spike:daemon.clients",
        severity: "warn", source: "daemon", score: 0.6,
        title: "Client count สูงผิดปกติ",
        detail: "clients=" + m.value + " (baseline หยาบ > 20) — ควรตั้ง baseline เชิงสถิติจริง",
        ts: now,
      });
    }

    // TODO (น้องไวท์):
    //   • เก็บ time-series ที่ ctx.dataDir/anomaly-baseline.json (rolling window) คำนวณ mean/stddev → z-score
    //   • หรือเรียก AI (มี OPENAI_API_KEY / GEMINI_API_KEY ใน env) สรุป pattern — ใส่ timeout เองเสมอ
    //   • คืน score 0..1 เพื่อให้ panel จัดอันดับ; severity map จาก score
    return { anomalies };
  },
};
