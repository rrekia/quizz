// واجهة الفرض الإلكتروني على Netlify — تحفظ النتائج في Netlify Blobs (تخزين دائم ومجاني).
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";
import cfg from "./questions.mjs";

export const config = { path: ["/api/*", "/export.csv"] };

const norm = (s) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
const hash = (s) => createHash("sha256").update(s).digest("hex");
const clean = (s, n) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, n);
const DEV_RE = /^[A-Za-z0-9-]{16,64}$/;
const devHash = (d) => (typeof d === "string" && DEV_RE.test(d) ? hash("dev:" + d) : null);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

function pwOk(given) {
  const real = Buffer.from(String(process.env.ADMIN_PASSWORD || cfg.password || "1234"));
  const g = Buffer.from(String(given ?? ""));
  return g.length === real.length && timingSafeEqual(g, real);
}

const sortRows = (rows) =>
  rows.sort((a, b) => b.score - a.score || a.seconds - b.seconds || a.time.localeCompare(b.time));
const pub = (r) => ({ id: r.id, name: r.name, group: r.group, section: r.section, classGroup: r.classGroup, score: r.score, total: r.total, seconds: r.seconds, time: r.time });

async function allRows(results) {
  const { blobs } = await results.list();
  const rows = await Promise.all(blobs.map((b) => results.get(b.key, { type: "json" })));
  return rows.filter(Boolean);
}

let cache = { t: 0, rows: null };
const invalidate = () => { cache = { t: 0, rows: null }; };

export default async (req) => {
  const url = new URL(req.url);
  const p = url.pathname;
  const results = getStore({ name: "results", consistency: "strong" });
  const devices = getStore({ name: "devices", consistency: "strong" });

  if (req.method === "GET") {
    if (p === "/api/quiz") {
      return json({
        title: cfg.title || "الفرض الإلكتروني",
        questions: cfg.questions.map((q, id) => ({ id, q: q.q, options: q.options, ...(q.image ? { image: q.image } : {}) })),
      });
    }
    if (p === "/api/board") {
      if (!cache.rows || Date.now() - cache.t > 3000) {
        cache = { t: Date.now(), rows: sortRows(await allRows(results)).map(pub) };
      }
      return json(cache.rows);
    }
    if (p === "/api/check") {
      const key = hash(norm(url.searchParams.get("name")) + "|" + norm(url.searchParams.get("group")) + "|" + norm(url.searchParams.get("classGroup")));
      const dh = devHash(url.searchParams.get("device"));
      if (dh && (await devices.get(dh)) !== null) return json({ exists: true, reason: "device" });
      if ((await results.get(key)) !== null) return json({ exists: true, reason: "name" });
      return json({ exists: false });
    }
    if (p === "/api/mine") {
      const dh = devHash(url.searchParams.get("device"));
      if (!dh) return json({ row: null });
      const claim = await devices.get(dh, { type: "json" });
      if (!claim) return json({ row: null });
      const row = await results.get(claim.key, { type: "json" });
      if (!row) { await devices.delete(dh); return json({ row: null }); }
      return json({ row: pub(row) });
    }
    if (p === "/export.csv") {
      if (!pwOk(url.searchParams.get("pw"))) return json({ error: "كلمة السر خاطئة" }, 403);
      const rows = sortRows(await allRows(results));
      const esc = (v) => `"${String(v).replaceAll('"', '""')}"`;
      const lines = [["الترتيب", "الاسم", "القسم", "الفوج", "النقطة", "من", "المدة (ثانية)", "الوقت"].map(esc).join(",")];
      rows.forEach((r, i) => lines.push([i + 1, r.name, r.group, r.classGroup || "", r.score, r.total, r.seconds, r.time].map(esc).join(",")));
      return new Response("﻿" + lines.join("\r\n"), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=results.csv", "Cache-Control": "no-store" },
      });
    }
    return json({ error: "not found" }, 404);
  }

  if (req.method === "POST") {
    let body = null;
    try {
      const text = await req.text();
      if (text.length > 65536) throw new Error("big");
      body = JSON.parse(text);
    } catch { /* body stays null */ }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "طلب غير صالح" }, 400);

    if (p === "/api/submit") {
      const name = clean(body.name, 40);
      const group = clean(body.group, 30);
      const classGroup = clean(body.classGroup, 20);
      if (!name) return json({ error: "الاسم مطلوب" }, 400);
      if (!group || !classGroup) return json({ error: "القسم والفوج مطلوبان" }, 400);
      const dh = devHash(body.device);
      if (!dh) return json({ error: "تعذر تحديد الجهاز. أعد تحميل الصفحة." }, 400);
      const answers = body.answers;
      if (!Array.isArray(answers) || answers.length !== cfg.questions.length) return json({ error: "إجابات غير صالحة" }, 400);
      const score = cfg.questions.reduce((s, q, i) => s + (Number.isInteger(answers[i]) && answers[i] === q.answer ? 1 : 0), 0);
      let seconds = parseInt(body.seconds, 10);
      if (!Number.isFinite(seconds)) seconds = 0;
      seconds = Math.max(0, Math.min(seconds, 86400));
      const key = hash(norm(name) + "|" + norm(group) + "|" + norm(classGroup));
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const row = {
        id: key, dev: dh, name, group, classGroup, score, total: 20, seconds,
        time: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`,
      };
      // 1) حجز الجهاز (ذرّي): إن كان محجوزًا فقد أنجز الفرض من قبل
      const claim = await devices.setJSON(dh, { key }, { onlyIfNew: true });
      if (!claim.modified) return json({ error: "تم إنجاز الفرض من هذا الجهاز من قبل. لا يمكن إعادة المحاولة." }, 409);
      // 2) حجز الاسم والقسم (ذرّي)
      const res = await results.setJSON(key, row, { onlyIfNew: true });
      if (!res.modified) {
        await devices.delete(dh);
        return json({ error: "هذا التلميذ أنجز الفرض من قبل. لا يمكن إعادة المحاولة." }, 409);
      }
      invalidate();
      return json({ ok: true, id: key, score, total: row.total });
    }

    if (p === "/api/admin/delete") {
      if (!pwOk(body.password)) return json({ error: "كلمة السر خاطئة" }, 403);
      const id = String(body.id ?? "");
      const row = await results.get(id, { type: "json" });
      await results.delete(id);
      if (row && row.dev) await devices.delete(row.dev);
      invalidate();
      return json({ ok: true });
    }

    if (p === "/api/admin/reset") {
      if (!pwOk(body.password)) return json({ error: "كلمة السر خاطئة" }, 403);
      for (const st of [results, devices]) {
        const { blobs } = await st.list();
        await Promise.all(blobs.map((b) => st.delete(b.key)));
      }
      invalidate();
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
};
