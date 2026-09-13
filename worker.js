const CHATTERBOX_SPACE =
  "https://resembleai-chatterbox-multilingual-tts.hf.space";

const DENOISE_SPACE =
  "https://multimodalart-resemble-enhance-zerogpu.hf.space";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // الصفحة الرئيسية
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Goku Voice AI is running.", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        }
      });
    }

    // توليد الصوت
    if (
      request.method === "POST" &&
      url.pathname === "/api/generate"
    ) {
      try {
        const form = await request.formData();

        const text = form.get("text");
        const language = form.get("language") || "en";
        const voice = form.get("voice");

        if (!text || typeof text !== "string") {
          return json(
            { error: "اكتب نصاً أولاً." },
            400
          );
        }

        if (!voice || typeof voice === "string") {
          return json(
            { error: "لم يتم إرسال عينة صوتية." },
            400
          );
        }

        if (!["ar", "en", "ja"].includes(language)) {
          return json(
            { error: "اللغة غير مدعومة." },
            400
          );
        }

        const cleanText = normalizeText(
          text,
          language
        );

        // =========================================
        // 1. إزالة الضوضاء من العينة
        // =========================================

        const denoisedVoice =
          await removeNoise(voice);

        // =========================================
        // 2. رفع العينة النظيفة إلى Chatterbox
        // =========================================

        const chatterboxUpload =
          new FormData();

        chatterboxUpload.append(
          "files",
          new File(
            [
              denoisedVoice.bytes
            ],
            "clean_voice.wav",
            {
              type: "audio/wav"
            }
          )
        );

        const uploadResponse =
          await fetch(
            `${CHATTERBOX_SPACE}/gradio_api/upload`,
            {
              method: "POST",
              body: chatterboxUpload
            }
          );

        if (!uploadResponse.ok) {
          throw new Error(
            "فشل رفع الصوت إلى Chatterbox."
          );
        }

        const uploaded =
          await uploadResponse.json();

        if (
          !Array.isArray(uploaded) ||
          !uploaded[0]
        ) {
          throw new Error(
            "Chatterbox لم يستقبل العينة."
          );
        }

        const audioPath =
          uploaded[0];

        // =========================================
        // 3. بدء توليد الصوت
        // =========================================

        const generateResponse =
          await fetch(
            `${CHATTERBOX_SPACE}/gradio_api/call/generate_tts_audio`,
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json"
              },
              body: JSON.stringify({
                data: [
                  cleanText,
                  language,
                  {
                    path: audioPath,
                    meta: {
                      _type:
                        "gradio.FileData"
                    },
                    orig_name:
                      "clean_voice.wav"
                  },

                  // exaggeration
                  0.5,

                  // temperature
                  0.75,

                  // seed
                  0,

                  // cfg
                  0.5
                ]
              })
            }
          );

        if (!generateResponse.ok) {
          throw new Error(
            "فشل بدء توليد الصوت."
          );
        }

        const generateData =
          await generateResponse.json();

        if (!generateData.event_id) {
          throw new Error(
            "لم يتم الحصول على event_id."
          );
        }

        // =========================================
        // 4. انتظار النتيجة النهائية
        // =========================================

        const generatedAudio =
          await waitForSSEAudio(
            CHATTERBOX_SPACE,
            "generate_tts_audio",
            generateData.event_id
          );

        if (!generatedAudio) {
          throw new Error(
            "لم يتم العثور على الصوت الناتج."
          );
        }

        // =========================================
        // 5. إرسال الصوت إلى المتصفح
        // =========================================

        return new Response(
          generatedAudio,
          {
            status: 200,
            headers: {
              "Content-Type":
                "audio/wav",
              "Cache-Control":
                "no-store",
              "Access-Control-Allow-Origin":
                "*"
            }
          }
        );

      } catch (error) {
        console.error(
          "GENERATION ERROR:",
          error
        );

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

    return new Response(
      "Not Found",
      { status: 404 }
    );
  }
};


// =====================================================
// إزالة الضوضاء
// =====================================================

async function removeNoise(voice) {
  const originalBytes =
    await voice.arrayBuffer();

  const uploadForm =
    new FormData();

  uploadForm.append(
    "files",
    new File(
      [originalBytes],
      voice.name ||
        "input_audio",
      {
        type:
          voice.type ||
          "audio/wav"
      }
    )
  );

  const uploadResponse =
    await fetch(
      `${DENOISE_SPACE}/gradio_api/upload`,
      {
        method: "POST",
        body: uploadForm
      }
    );

  if (!uploadResponse.ok) {
    throw new Error(
      "فشل رفع العينة إلى مزيل الضوضاء."
    );
  }

  const uploaded =
    await uploadResponse.json();

  if (
    !Array.isArray(uploaded) ||
    !uploaded[0]
  ) {
    throw new Error(
      "مزيل الضوضاء لم يستقبل العينة."
    );
  }

  const audioPath =
    uploaded[0];

  // =========================================
  // بدء عملية إزالة الضوضاء
  // =========================================

  const predictResponse =
    await fetch(
      `${DENOISE_SPACE}/gradio_api/call/predict`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          data: [
            {
              path: audioPath,
              meta: {
                _type:
                  "gradio.FileData"
              },
              orig_name:
                voice.name ||
                "input_audio"
            },

            // solver
            "Midpoint",

            // NFE
            64,

            // tau
            0.5,

            // denoising
            true
          ]
        })
      }
    );

  if (!predictResponse.ok) {
    throw new Error(
      "فشل تشغيل مزيل الضوضاء."
    );
  }

  const predictData =
    await predictResponse.json();

  if (!predictData.event_id) {
    throw new Error(
      "مزيل الضوضاء لم يُرجع event_id."
    );
  }

  // =========================================
  // انتظار النتيجة النهائية
  // =========================================

  const cleanAudio =
    await waitForSSEAudio(
      DENOISE_SPACE,
      "predict",
      predictData.event_id
    );

  if (!cleanAudio) {
    throw new Error(
      "لم يتم العثور على الصوت المنظف."
    );
  }

  return {
    bytes: cleanAudio,
    name: "clean_voice.wav"
  };
}


// =====================================================
// انتظار نتيجة Gradio SSE
// =====================================================

async function waitForSSEAudio(
  baseUrl,
  endpoint,
  eventId
) {
  const response =
    await fetch(
      `${baseUrl}/gradio_api/call/${endpoint}/${eventId}`
    );

  if (!response.ok) {
    throw new Error(
      "فشل الاتصال بنتيجة المعالجة."
    );
  }

  const text =
    await response.text();

  return parseCompletedSSE(
    text,
    baseUrl
  );
}


// =====================================================
// قراءة SSE
// =====================================================

async function parseCompletedSSE(
  text,
  baseUrl
) {
  const blocks =
    text.split(/\n\n+/);

  for (const block of blocks) {
    const eventMatch =
      block.match(
        /(?:^|\n)event:\s*([^\n]+)/i
      );

    const dataMatch =
      block.match(
        /(?:^|\n)data:\s*([\s\S]+)/i
      );

    if (!eventMatch || !dataMatch) {
      continue;
    }

    const eventName =
      eventMatch[1].trim();

    const rawData =
      dataMatch[1]
        .trim();

    // النتيجة النهائية فقط
    if (eventName === "complete") {
      try {
        const data =
          JSON.parse(rawData);

        const audio =
          findAudioFile(data);

        if (!audio) {
          return null;
        }

        return await downloadAudio(
          baseUrl,
          audio
        );

      } catch (error) {
        console.error(
          "SSE PARSE ERROR:",
          error
        );

        return null;
      }
    }

    // في حالة حدوث خطأ من الخدمة
    if (eventName === "error") {
      let message =
        "خدمة الصوت أعادت خطأ.";

      try {
        const parsed =
          JSON.parse(rawData);

        if (typeof parsed === "string") {
          message = parsed;
        }
      } catch {}

      throw new Error(message);
    }
  }

  return null;
}


// =====================================================
// العثور على ملف الصوت داخل النتيجة
// =====================================================

function findAudioFile(value) {
  if (!value) {
    return null;
  }

  if (
    typeof value === "object"
  ) {
    // FileData URL
    if (
      typeof value.url ===
      "string"
    ) {
      return value;
    }

    // FileData path
    if (
      typeof value.path ===
      "string"
    ) {
      return value;
    }

    // Array
    if (Array.isArray(value)) {
      for (
        const item of value
      ) {
        const found =
          findAudioFile(item);

        if (found) {
          return found;
        }
      }
    }

    // Object
    for (
      const key of Object.keys(value)
    ) {
      const found =
        findAudioFile(
          value[key]
        );

      if (found) {
        return found;
      }
    }
  }

  return null;
}


// =====================================================
// تحميل ملف الصوت
// =====================================================

async function downloadAudio(
  baseUrl,
  audio
) {
  let audioUrl = null;

  // إذا أعادت Gradio رابطًا مباشرًا
  if (
    audio.url &&
    typeof audio.url ===
      "string"
  ) {
    audioUrl =
      audio.url;
  }

  // إذا أعادت path
  else if (
    audio.path &&
    typeof audio.path ===
      "string"
  ) {
    if (
      audio.path.startsWith(
        "http://"
      ) ||
      audio.path.startsWith(
        "https://"
      )
    ) {
      audioUrl =
        audio.path;
    } else {
      audioUrl =
        `${baseUrl}/gradio_api/file=` +
        encodeURIComponent(
          audio.path
        );
    }
  }

  if (!audioUrl) {
    return null;
  }

  const response =
    await fetch(audioUrl);

  if (!response.ok) {
    return null;
  }

  return await response.arrayBuffer();
}


// =====================================================
// تنظيف النص
// =====================================================

function normalizeText(
  text,
  language
) {
  let result =
    text
      .trim()
      .slice(0, 300);

  if (language === "en") {
    result =
      result
        .replace(
          /\s+/g,
          " "
        )
        .replace(
          /\s+([!?.,:;])/g,
          "$1"
        )
        .replace(
          /([!?.,:;])(?=[A-Za-z])/g,
          "$1 "
        );
  }

  if (language === "ar") {
    result =
      result
        .replace(
          /\s+/g,
          " "
        )
        .replace(
          /\s+([،؛؟!.,])/g,
          "$1"
        );
  }

  if (language === "ja") {
    result =
      result
        .replace(
          /\s+/g,
          " "
        )
        .replace(
          /\s+([。、！？])/g,
          "$1"
        );
  }

  return result;
}


// =====================================================
// JSON
// =====================================================

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Access-Control-Allow-Origin":
          "*"
      }
    }
  );
    }     status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}
