const CHATTERBOX_SPACE =
  "https://resembleai-chatterbox-multilingual-tts.hf.space";

const DENOISE_SPACE =
  "https://multimodalart-resemble-enhance-zerogpu.hf.space";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Goku Voice AI is running.", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/api/generate") {
      try {
        const form = await request.formData();

        const text = form.get("text");
        const language = form.get("language") || "en";
        const voice = form.get("voice");

        if (!text || typeof text !== "string") {
          return json({ error: "اكتب نصاً أولاً." }, 400);
        }

        if (!voice || typeof voice === "string") {
          return json({ error: "لم يتم إرسال عينة صوتية." }, 400);
        }

        if (!["ar", "en", "ja"].includes(language)) {
          return json({ error: "اللغة غير مدعومة." }, 400);
        }

        const cleanText = normalizeText(text, language);

        // ==========================================
        // 1. إزالة الضوضاء بالذكاء الاصطناعي
        // ==========================================

        const denoisedVoice = await removeNoise(voice);

        // ==========================================
        // 2. إرسال الصوت النظيف إلى Chatterbox
        // ==========================================

        const uploadForm = new FormData();

        uploadForm.append(
          "files",
          new File(
            [denoisedVoice.bytes],
            denoisedVoice.name || "clean_voice.wav",
            {
              type: "audio/wav"
            }
          )
        );

        const uploadResponse = await fetch(
          `${CHATTERBOX_SPACE}/gradio_api/upload`,
          {
            method: "POST",
            body: uploadForm
          }
        );

        if (!uploadResponse.ok) {
          throw new Error("فشل رفع الصوت إلى Chatterbox.");
        }

        const uploaded = await uploadResponse.json();

        if (!Array.isArray(uploaded) || !uploaded[0]) {
          throw new Error("Chatterbox لم يُرجع ملف الصوت.");
        }

        const audioPath = uploaded[0];

        // ==========================================
        // 3. توليد الصوت
        // ==========================================

        const generateResponse = await fetch(
          `${CHATTERBOX_SPACE}/gradio_api/call/generate_tts_audio`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              data: [
                cleanText,
                language,
                {
                  path: audioPath,
                  meta: {
                    _type: "gradio.FileData"
                  },
                  orig_name: "clean_voice.wav"
                },

                // إعدادات Chatterbox
                0.5, // exaggeration
                0.75, // temperature
                0, // seed
                0.5 // cfg
              ]
            })
          }
        );

        if (!generateResponse.ok) {
          throw new Error("فشل بدء توليد الصوت.");
        }

        const generateData = await generateResponse.json();

        if (!generateData.event_id) {
          throw new Error("لم يتم الحصول على event_id.");
        }

        // ==========================================
        // 4. انتظار نتيجة Chatterbox
        // ==========================================

        const resultResponse = await fetch(
          `${CHATTERBOX_SPACE}/gradio_api/call/generate_tts_audio/${generateData.event_id}`
        );

        if (!resultResponse.ok) {
          throw new Error("فشل الحصول على نتيجة الصوت.");
        }

        const resultText = await resultResponse.text();

        const audioResult = extractAudioFromSSE(resultText);

        if (!audioResult) {
          throw new Error("لم يتم العثور على الصوت الناتج.");
        }

        const finalAudio = await fetchAudioResult(
          CHATTERBOX_SPACE,
          audioResult
        );

        if (!finalAudio) {
          throw new Error("تعذر تحميل الصوت الناتج.");
        }

        return new Response(finalAudio, {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "Cache-Control": "no-store"
          }
        });

      } catch (error) {
        console.error(error);

        return json(
          {
            error:
              error?.message ||
              "حدث خطأ أثناء معالجة الصوت."
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


// ==================================================
// إزالة الضوضاء باستخدام Resemble Enhance
// ==================================================

async function removeNoise(voice) {
  const uploadForm = new FormData();

  uploadForm.append(
    "files",
    new File(
      [await voice.arrayBuffer()],
      voice.name || "input_audio",
      {
        type: voice.type || "audio/wav"
      }
    )
  );

  const uploadResponse = await fetch(
    `${DENOISE_SPACE}/gradio_api/upload`,
    {
      method: "POST",
      body: uploadForm
    }
  );

  if (!uploadResponse.ok) {
    throw new Error("فشل رفع العينة إلى مزيل الضوضاء.");
  }

  const uploaded = await uploadResponse.json();

  if (!Array.isArray(uploaded) || !uploaded[0]) {
    throw new Error("مزيل الضوضاء لم يستقبل العينة.");
  }

  const audioPath = uploaded[0];

  // تشغيل /predict
  const predictResponse = await fetch(
    `${DENOISE_SPACE}/gradio_api/call/predict`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: [
          {
            path: audioPath,
            meta: {
              _type: "gradio.FileData"
            },
            orig_name: voice.name || "input_audio"
          },

          "Midpoint",
          64,
          0.5,

          // تشغيل إزالة الضوضاء
          true
        ]
      })
    }
  );

  if (!predictResponse.ok) {
    throw new Error("فشل تشغيل مزيل الضوضاء.");
  }

  const predictData = await predictResponse.json();

  if (!predictData.event_id) {
    throw new Error("مزيل الضوضاء لم يُرجع event_id.");
  }

  // انتظار النتيجة
  const resultResponse = await fetch(
    `${DENOISE_SPACE}/gradio_api/call/predict/${predictData.event_id}`
  );

  if (!resultResponse.ok) {
    throw new Error("فشل الحصول على الصوت المنظف.");
  }

  const resultText = await resultResponse.text();

  const result = extractAudioFromSSE(resultText);

  if (!result) {
    throw new Error("لم يتم العثور على الصوت المنظف.");
  }

  const cleanAudio = await fetchAudioResult(
    DENOISE_SPACE,
    result
  );

  if (!cleanAudio) {
    throw new Error("تعذر تحميل الصوت المنظف.");
  }

  return {
    bytes: cleanAudio,
    name: "clean_voice.wav"
  };
}


// ==================================================
// استخراج ملف الصوت من SSE
// ==================================================

function extractAudioFromSSE(text) {
  const lines = text.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;

    const raw = line.slice(5).trim();

    if (!raw || raw === "[DONE]") continue;

    try {
      const data = JSON.parse(raw);

      // الناتج عادة Array
      if (Array.isArray(data)) {
        for (const item of data) {
          const found = findAudioObject(item);

          if (found) {
            return found;
          }
        }
      } else {
        const found = findAudioObject(data);

        if (found) {
          return found;
        }
      }
    } catch {
      // تجاهل أسطر SSE غير JSON
    }
  }

  return null;
}


// ==================================================
// البحث عن FileData
// ==================================================

function findAudioObject(value) {
  if (!value) return null;

  if (typeof value === "object") {
    if (
      value.url ||
      value.path
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findAudioObject(item);

        if (found) return found;
      }
    }

    for (const key of Object.keys(value)) {
      const found = findAudioObject(value[key]);

      if (found) return found;
    }
  }

  return null;
}


// ==================================================
// تحميل ملف الصوت الناتج
// ==================================================

async function fetchAudioResult(baseUrl, audio) {
  let url = audio.url;

  if (!url && audio.path) {
    if (audio.path.startsWith("http")) {
      url = audio.path;
    } else {
      url =
        `${baseUrl}/gradio_api/file=` +
        encodeURIComponent(audio.path);
    }
  }

  if (!url) {
    return null;
  }

  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  return await response.arrayBuffer();
}


// ==================================================
// تنظيف النص
// ==================================================

function normalizeText(text, language) {
  let result = text
    .trim()
    .slice(0, 300);

  if (language === "en") {
    result = result
      .replace(/\s+/g, " ")
      .replace(/\s+([!?.,:;])/g, "$1")
      .replace(/([!?.,:;])(?=[A-Za-z])/g, "$1 ");
  }

  if (language === "ar") {
    result = result
      .replace(/\s+/g, " ")
      .replace(/\s+([،؛؟!.,])/g, "$1");
  }

  if (language === "ja") {
    result = result
      .replace(/\s+/g, " ")
      .replace(/\s+([。、！？])/g, "$1");
  }

  return result;
}


// ==================================================
// JSON Response
// ==================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}
