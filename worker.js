const CHATTERBOX = "https://resembleai-chatterbox-multilingual-tts.hf.space";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Goku Voice AI is running.", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    if (request.method !== "POST" || url.pathname !== "/api/generate") {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const form = await request.formData();
      const text = form.get("text");
      const language = form.get("language") || "en";
      const voice = form.get("voice");

      if (!text) return json({ error: "اكتب نصاً أولاً." }, 400);
      if (!voice) return json({ error: "لم يتم إرسال عينة صوتية." }, 400);

      // ============================
      // تسجيل المدخلات
      // ============================
      const diag = {
        language,
        textLength: text.length,
        textSample: text.slice(0, 50),
        voiceName: voice.name,
        voiceType: voice.type,
        voiceSize: voice.size
      };
      console.log("INPUT:", JSON.stringify(diag));

      // ============================
      // رفع العينة إلى Chatterbox
      // ============================
      const originalBytes = await voice.arrayBuffer();
      const upForm = new FormData();
      upForm.append(
        "files",
        new File([originalBytes], voice.name || "input.wav", {
          type: voice.type || "audio/wav"
        })
      );

      const upRes = await fetch(`${CHATTERBOX}/gradio_api/upload`, {
        method: "POST",
        body: upForm
      });

      const upText = await upRes.text();
      console.log(`UPLOAD status=${upRes.status} body=${upText.slice(0, 300)}`);

      if (!upRes.ok) {
        return json(
          { error: `فشل الرفع (${upRes.status}): ${upText.slice(0, 300)}` },
          500
        );
      }

      let uploaded;
      try {
        uploaded = JSON.parse(upText);
      } catch {
        return json({ error: `رد رفع غير صالح: ${upText.slice(0, 300)}` }, 500);
      }

      if (!Array.isArray(uploaded) || !uploaded[0]) {
        return json(
          { error: `Chatterbox لم يستقبل العينة: ${upText.slice(0, 300)}` },
          500
        );
      }
      const audioPath = uploaded[0];
      console.log("UPLOAD OK path=", audioPath);

      // ============================
      // طلب التوليد
      // ============================
      const payload = {
        data: [
          text,
          language,
          {
            path: audioPath,
            meta: { _type: "gradio.FileData" },
            orig_name: "input.wav"
          },
          0.5,   // exaggeration
          0.7,   // temperature
          0,     // seed
          0.7    // cfg_weight
        ]
      };
      console.log("PAYLOAD:", JSON.stringify(payload).slice(0, 500));

      const genRes = await fetch(
        `${CHATTERBOX}/gradio_api/call/generate_tts_audio`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );

      const genText = await genRes.text();
      console.log(`GEN status=${genRes.status} body=${genText.slice(0, 500)}`);

      if (!genRes.ok) {
        return json(
          {
            error: `فشل بدء التوليد (${genRes.status}): ${genText.slice(0, 400)}`
          },
          500
        );
      }

      let genData;
      try {
        genData = JSON.parse(genText);
      } catch {
        return json({ error: `رد توليد غير صالح: ${genText.slice(0, 400)}` }, 500);
      }

      if (!genData.event_id) {
        return json(
          {
            error: `لا يوجد event_id. الرد: ${genText.slice(0, 400)}`
          },
          500
        );
      }

      // ============================
      // انتظار النتيجة SSE
      // ============================
      const sseRes = await fetch(
        `${CHATTERBOX}/gradio_api/call/generate_tts_audio/${genData.event_id}`
      );

      if (!sseRes.ok) {
        const sseErr = await sseRes.text();
        return json(
          {
            error: `فشل SSE (${sseRes.status}): ${sseErr.slice(0, 400)}`
          },
          500
        );
      }

      const sseText = await sseRes.text();
      console.log("SSE RAW (first 1500):", sseText.slice(0, 1500));

      // ============================
      // محاولة استخراج الصوت
      // ============================
      const audio = await parseSSE(sseText);

      if (!audio) {
        // نرجع نص SSE كاملاً ليظهر للمستخدم
        return json(
          {
            error: `لم يتم استخراج صوت. الرد الفعلي من Chatterbox:\n${sseText.slice(0, 800)}`
          },
          500
        );
      }

      // ============================
      // تحميل الصوت
      // ============================
      let audioUrl = null;
      if (audio.url) audioUrl = audio.url;
      else if (audio.path) {
        audioUrl = audio.path.startsWith("http")
          ? audio.path
          : `${CHATTERBOX}/gradio_api/file=` + encodeURIComponent(audio.path);
      }

      if (!audioUrl) {
        return json({ error: `لا يوجد رابط صوت. التفاصيل: ${JSON.stringify(audio).slice(0, 400)}` }, 500);
      }

      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) {
        return json({ error: `فشل تحميل الصوت (${audioRes.status})` }, 500);
      }

      const audioBuf = await audioRes.arrayBuffer();
      console.log(`AUDIO OK size=${audioBuf.byteLength}`);

      return new Response(audioBuf, {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (error) {
      console.error("FATAL:", error);
      return json(
        { error: `خطأ داخلي: ${error.message || String(error)}` },
        500
      );
    }
  }
};

async function parseSSE(text) {
  const blocks = text.split(/\n\n+/);

  for (const block of blocks) {
    const eM = block.match(/(?:^|\n)event:\s*([^\n]+)/i);
    const dM = block.match(/(?:^|\n)data:\s*([\s\S]+)/i);

    if (!eM || !dM) continue;

    const eventName = eM[1].trim();
    const rawData = dM[1].trim();

    if (eventName === "complete") {
      try {
        const data = JSON.parse(rawData);
        const file = findFile(data);
        if (file) return file;
      } catch (e) {
        console.error("PARSE ERROR:", e);
      }
    }

    if (eventName === "error") {
      console.error("ERROR EVENT rawData:", rawData);
      return null;
    }
  }

  return null;
}

function findFile(value) {
  if (!value) return null;
  if (typeof value === "object") {
    if (typeof value.url === "string") return value;
    if (typeof value.path === "string") return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findFile(item);
        if (found) return found;
      }
    }
    for (const key of Object.keys(value)) {
      const found = findFile(value[key]);
      if (found) return found;
    }
  }
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
    }
