const HF_SPACE =
  "https://resembleai-chatterbox-multilingual-tts.hf.space";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // الصفحة الرئيسية
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Goku Voice AI Worker is running.", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // API التوليد
    if (request.method === "POST" && url.pathname === "/api/generate") {
      try {
        const form = await request.formData();

        const text = form.get("text");
        const language = form.get("language") || "en";
        const voice = form.get("voice");

        if (!text) {
          return json({ error: "اكتب نصاً أولاً." }, 400);
        }

        if (!voice || typeof voice === "string") {
          return json({ error: "لم يتم إرسال عينة صوتية." }, 400);
        }

        if (!["ar", "en", "ja"].includes(language)) {
          return json({ error: "اللغة غير مدعومة." }, 400);
        }

        // 1. رفع عينة الصوت إلى Gradio
        const uploadData = new FormData();
        uploadData.append("files", voice, voice.name || "voice.mp3");

        const uploadResponse = await fetch(
          `${HF_SPACE}/gradio_api/upload`,
          {
            method: "POST",
            body: uploadData
          }
        );

        if (!uploadResponse.ok) {
          const errorText = await uploadResponse.text();
          return json(
            {
              error: "فشل رفع عينة الصوت.",
              details: errorText
            },
            500
          );
        }

        const uploaded = await uploadResponse.json();
        const audioPath = uploaded[0];

        // 2. إرسال طلب التوليد
        const callResponse = await fetch(
          `${HF_SPACE}/gradio_api/call/generate_tts_audio`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              data: [
                text,
                language,
                {
                  path: audioPath,
                  meta: {
                    _type: "gradio.FileData"
                  },
                  orig_name: voice.name || "voice.mp3"
                },
                0.5,
                0.8,
                0,
                0.5
              ]
            })
          }
        );

        if (!callResponse.ok) {
          const errorText = await callResponse.text();

          return json(
            {
              error: "فشل إرسال طلب التوليد.",
              details: errorText
            },
            500
          );
        }

        const callData = await callResponse.json();
        const eventId = callData.event_id;

        if (!eventId) {
          return json(
            {
              error: "لم يتم الحصول على رقم المهمة."
            },
            500
          );
        }

        // 3. انتظار النتيجة
        const resultResponse = await fetch(
          `${HF_SPACE}/gradio_api/call/generate_tts_audio/${eventId}`
        );

        if (!resultResponse.ok) {
          const errorText = await resultResponse.text();

          return json(
            {
              error: "فشل الحصول على نتيجة الصوت.",
              details: errorText
            },
            500
          );
        }

        const resultText = await resultResponse.text();

        // Gradio يرجع النتيجة كـ SSE
        const lines = resultText.split("\n");

        let audioData = null;

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();

            try {
              const parsed = JSON.parse(data);

              if (Array.isArray(parsed) && parsed.length > 0) {
                audioData = parsed[0];
              }
            } catch (_) {}
          }
        }

        if (!audioData) {
          return json(
            {
              error: "لم يتم العثور على ملف الصوت.",
              raw: resultText
            },
            500
          );
        }

        // 4. الحصول على رابط الملف الناتج
        let audioURL;

        if (typeof audioData === "string") {
          audioURL = audioData;
        } else {
          audioURL = audioData.url;
        }

        if (!audioURL) {
          return json(
            {
              error: "رابط الصوت غير موجود.",
              data: audioData
            },
            500
          );
        }

        // 5. تنزيل الصوت وإرساله للموقع
        const audioResponse = await fetch(audioURL);

        if (!audioResponse.ok) {
          return json(
            {
              error: "تعذر تنزيل الصوت الناتج."
            },
            500
          );
        }

        return new Response(audioResponse.body, {
          status: 200,
          headers: {
            "Content-Type":
              audioResponse.headers.get("Content-Type") ||
              "audio/wav",
            "Cache-Control": "no-store"
          }
        });

      } catch (error) {
        return json(
          {
            error: "حدث خطأ داخل Worker.",
            details: error.message
          },
          500
        );
      }
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
          }
