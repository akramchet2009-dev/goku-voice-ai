const CHATTERBOX_SPACE =
  "https://resembleai-chatterbox-multilingual-tts.hf.space";

const DENOISE_SPACE =
  "https://multimodalart-resemble-enhance-zerogpu.hf.space";

const MAX_TEXT_LENGTH = 2000;

// Chatterbox لديه حد أقصى 300 حرف.
// نستخدم 280 حتى نترك هامش أمان.
const CHUNK_SIZE = 280;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // CORS
    // =========================

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type"
        }
      });
    }

    // =========================
    // الصفحة الرئيسية
    // =========================

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return new Response(
        "Goku Voice AI is running.",
        {
          status: 200,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    // =========================
    // توليد الصوت
    // =========================

    if (
      request.method === "POST" &&
      url.pathname === "/api/generate"
    ) {
      try {
        const form =
          await request.formData();

        const text =
          form.get("text");

        const language =
          form.get("language") || "en";

        const voice =
          form.get("voice");

        // =========================
        // التحقق من النص
        // =========================

        if (
          !text ||
          typeof text !== "string"
        ) {
          return json(
            {
              error:
                "اكتب نصاً أولاً."
            },
            400
          );
        }

        // =========================
        // التحقق من الصوت
        // =========================

        if (
          !voice ||
          typeof voice === "string"
        ) {
          return json(
            {
              error:
                "لم يتم إرسال عينة صوتية."
            },
            400
          );
        }

        // =========================
        // التحقق من اللغة
        // =========================

        if (
          ![
            "ar",
            "en",
            "ja"
          ].includes(language)
        ) {
          return json(
            {
              error:
                "اللغة غير مدعومة."
            },
            400
          );
        }

        // =========================
        // تنظيف النص
        // =========================

        const cleanText =
          normalizeText(
            text,
            language
          );

        if (!cleanText) {
          return json(
            {
              error:
                "النص فارغ."
            },
            400
          );
        }

        // =========================
        // الحد الأقصى
        // =========================

        if (
          cleanText.length >
          MAX_TEXT_LENGTH
        ) {
          return json(
            {
              error:
                `الحد الأقصى للنص هو ${MAX_TEXT_LENGTH} حرف.`
            },
            400
          );
        }

        // =========================
        // تقسيم النص
        // =========================

        const chunks =
          splitTextIntoChunks(
            cleanText,
            language
          );

        if (
          !chunks.length
        ) {
          return json(
            {
              error:
                "لم يتم العثور على نص صالح."
            },
            400
          );
        }

        console.log(
          `Text length: ${cleanText.length}`
        );

        console.log(
          `Generating ${chunks.length} chunk(s)`
        );

        // =========================
        // إزالة الضوضاء مرة واحدة
        // =========================

        console.log(
          "Starting voice denoise..."
        );

        const denoisedVoice =
          await removeNoise(
            voice
          );

        if (
          !denoisedVoice ||
          !denoisedVoice.bytes
        ) {
          throw new Error(
            "فشل الحصول على الصوت المنظف."
          );
        }

        // =========================
        // رفع الصوت إلى Chatterbox
        // =========================

        console.log(
          "Uploading cleaned voice to Chatterbox..."
        );

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
              type:
                "audio/wav"
            }
          )
        );

        const uploadResponse =
          await fetch(
            `${CHATTERBOX_SPACE}/gradio_api/upload`,
            {
              method: "POST",
              body:
                chatterboxUpload
            }
          );

        if (
          !uploadResponse.ok
        ) {
          const errorText =
            await uploadResponse.text();

          throw new Error(
            `فشل رفع الصوت إلى Chatterbox. ${errorText}`
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

        console.log(
          "Voice uploaded successfully."
        );

        // =========================
        // توليد جميع المقاطع
        // =========================

        const audioChunks =
          [];

        for (
          let i = 0;
          i < chunks.length;
          i++
        ) {
          const chunk =
            chunks[i];

          console.log(
            `Generating chunk ${i + 1}/${chunks.length}`
          );

          console.log(
            chunk
          );

          const generatedAudio =
            await generateChatterboxAudio(
              chunk,
              language,
              audioPath
            );

          if (
            !generatedAudio
          ) {
            throw new Error(
              `فشل توليد الجزء ${i + 1} من ${chunks.length}.`
            );
          }

          audioChunks.push(
            generatedAudio
          );

          console.log(
            `Chunk ${i + 1} completed.`
          );
        }

        // =========================
        // دمج ملفات WAV
        // =========================

        console.log(
          "Merging audio files..."
        );

        const finalAudio =
          mergeWavFiles(
            audioChunks
          );

        if (!finalAudio) {
          throw new Error(
            "فشل دمج المقاطع الصوتية."
          );
        }

        console.log(
          "Final audio generated successfully."
        );

        // =========================
        // إرسال الصوت النهائي
        // =========================

        return new Response(
          finalAudio,
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
      {
        status: 404,
        headers: {
          "Access-Control-Allow-Origin":
            "*"
        }
      }
    );
  }
};


// ======================================================
// JSON RESPONSE
// ======================================================

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
}


// ======================================================
// تنظيف النص
// ======================================================

function normalizeText(
  text,
  language
) {
  return String(text)
    .replace(
      /\r\n/g,
      "\n"
    )
    .replace(
      /[ \t]+/g,
      " "
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}


// ======================================================
// توليد مقطع واحد من Chatterbox
// ======================================================

async function generateChatterboxAudio(
  text,
  language,
  audioPath
) {
  /*
    مهم جداً:

    عند استخدام عينة صوت بلغة مختلفة عن لغة
    النص، Chatterbox ينصح بجعل CFG = 0.

    لذلك:
    English -> 0
    Arabic  -> 0.35
    Japanese -> 0.35
  */

  const cfg =
    language === "en"
      ? 0
      : 0.35;

  console.log(
    `Chatterbox language=${language}, CFG=${cfg}`
  );

  const generateResponse =
    await fetch(
      `${CHATTERBOX_SPACE}/gradio_api/call/generate_tts_audio`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            data: [
              // النص
              text,

              // اللغة
              language,

              // الصوت المرجعي
              {
                path:
                  audioPath,

                meta: {
                  _type:
                    "gradio.FileData"
                },

                orig_name:
                  "clean_voice.wav"
              },

              // Exaggeration
              0.45,

              // Temperature
              0.60,

              // Seed
              0,

              // CFG / Pace
              cfg
            ]
          })
      }
    );

  if (
    !generateResponse.ok
  ) {
    const errorText =
      await generateResponse.text();

    throw new Error(
      `Chatterbox رفض طلب التوليد: ${errorText}`
    );
  }

  const generateData =
    await generateResponse.json();

  if (
    !generateData.event_id
  ) {
    throw new Error(
      "لم يتم الحصول على event_id من Chatterbox."
    );
  }

  console.log(
    "Chatterbox event:",
    generateData.event_id
  );

  return await waitForSSEAudio(
    CHATTERBOX_SPACE,
    "generate_tts_audio",
    generateData.event_id
  );
}


// ======================================================
// تقسيم النص الطويل
// ======================================================

function splitTextIntoChunks(
  text,
  language
) {
  const chunks = [];

  let remaining =
    text.trim();

  while (
    remaining.length > 0
  ) {
    // إذا كان المتبقي أقل من الحد
    if (
      remaining.length <=
      CHUNK_SIZE
    ) {
      chunks.push(
        remaining.trim()
      );

      break;
    }

    // نبحث عن أفضل مكان للقطع
    let cut =
      remaining.lastIndexOf(
        " ",
        CHUNK_SIZE
      );

    // علامات الترقيم
    const punctuationPositions =
      [
        remaining.lastIndexOf(
          ".",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          "!",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          "?",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          "؟",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          "،",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          ",",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          "؛",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          ";",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          "。",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          "！",
          CHUNK_SIZE
        ),

        remaining.lastIndexOf(
          "？",
          CHUNK_SIZE
        )
      ];

    // اختيار أقرب علامة ترقيم
    for (
      const position
      of punctuationPositions
    ) {
      if (
        position > 100 &&
        position > cut
      ) {
        cut =
          position + 1;
      }
    }

    // إذا لم نجد مكاناً جيداً
    if (
      cut <= 0 ||
      cut > CHUNK_SIZE
    ) {
      cut =
        CHUNK_SIZE;
    }

    const chunk =
      remaining
        .slice(
          0,
          cut
        )
        .trim();

    if (chunk) {
      chunks.push(
        chunk
      );
    }

    remaining =
      remaining
        .slice(cut)
        .trim();
  }

  return chunks;
}


// ======================================================
// إزالة الضوضاء
// ======================================================

async function removeNoise(
  voice
) {
  const originalBytes =
    await voice.arrayBuffer();

  const uploadForm =
    new FormData();

  uploadForm.append(
    "files",
    new File(
      [
        originalBytes
      ],
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
        body:
          uploadForm
      }
    );

  if (
    !uploadResponse.ok
  ) {
    const errorText =
      await uploadResponse.text();

    throw new Error(
      `فشل رفع العينة إلى مزيل الضوضاء. ${errorText}`
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

  const predictResponse =
    await fetch(
      `${DENOISE_SPACE}/gradio_api/call/predict`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            data: [
              {
                path:
                  audioPath,

                meta: {
                  _type:
                    "gradio.FileData"
                },

                orig_name:
                  voice.name ||
                  "input_audio"
              },

              "Midpoint",

              64,

              0.5,

              true
            ]
          })
      }
    );

  if (
    !predictResponse.ok
  ) {
    const errorText =
      await predictResponse.text();

    throw new Error(
      `فشل تشغيل مزيل الضوضاء. ${errorText}`
    );
  }

  const predictData =
    await predictResponse.json();

  if (
    !predictData.event_id
  ) {
    throw new Error(
      "مزيل الضوضاء لم يُرجع event_id."
    );
  }

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
    bytes:
      cleanAudio,

    name:
      "clean_voice.wav"
  };
}


// ======================================================
// انتظار نتيجة Gradio SSE
// ======================================================

async function waitForSSEAudio(
  baseUrl,
  endpoint,
  eventId
) {
  const response =
    await fetch(
      `${baseUrl}/gradio_api/call/${endpoint}/${eventId}`
    );

  if (
    !response.ok
  ) {
    const errorText =
      await response.text();

    throw new Error(
      `فشل الاتصال بنتيجة المعالجة. ${errorText}`
    );
  }

  const text =
    await response.text();

  return parseCompletedSSE(
    text,
    baseUrl
  );
}


// ======================================================
// تحليل SSE
// ======================================================

async function parseCompletedSSE(
  text,
  baseUrl
) {
  const blocks =
    text.split(
      /\n\n+/
    );

  for (
    const block
    of blocks
  ) {
    const eventMatch =
      block.match(
        /(?:^|\n)event:\s*([^\n]+)/i
      );

    const dataMatch =
      block.match(
        /(?:^|\n)data:\s*([\s\S]+)/i
      );

    if (
      !eventMatch ||
      !dataMatch
    ) {
      continue;
    }

    const eventName =
      eventMatch[1].trim();

    const rawData =
      dataMatch[1].trim();

    // =========================
    // العملية اكتملت
    // =========================

    if (
      eventName ===
      "complete"
    ) {
      try {
        const data =
          JSON.parse(
            rawData
          );

        const audio =
          findAudioFile(
            data
          );

        if (!audio) {
          throw new Error(
            "لم يتم العثور على ملف الصوت في نتيجة Chatterbox."
          );
        }

        return await downloadAudio(
          baseUrl,
          audio
        );

      } catch (error) {
        console.error(
          "SSE COMPLETE PARSE ERROR:",
          error
        );

        throw new Error(
          error?.message ||
          "تعذر قراءة الصوت الناتج."
        );
      }
    }

    // =========================
    // حدث خطأ
    // =========================

    if (
      eventName ===
      "error"
    ) {
      let message =
        "خدمة الصوت أعادت خطأ.";

      try {
        const parsed =
          JSON.parse(
            rawData
          );

        if (
          typeof parsed ===
          "string"
        ) {
          message =
            parsed;
        } else if (
          parsed &&
          typeof parsed ===
            "object"
        ) {
          message =
            parsed.message ||
            parsed.error ||
            parsed.detail ||
            JSON.stringify(
              parsed
            );
        }

      } catch {
        message =
          rawData ||
          message;
      }

      console.error(
        "CHATTERBOX ORIGINAL ERROR:",
        rawData
      );

      throw new Error(
        `Chatterbox: ${message}`
      );
    }
  }

  throw new Error(
    "لم تُرجع خدمة الصوت نتيجة مكتملة."
  );
}


// ======================================================
// البحث عن ملف الصوت داخل نتيجة Gradio
// ======================================================

function findAudioFile(
  value
) {
  if (!value) {
    return null;
  }

  // إذا كانت Array
  if (
    Array.isArray(value)
  ) {
    for (
      const item
      of value
    ) {
      const found =
        findAudioFile(
          item
        );

      if (found) {
        return found;
      }
    }

    return null;
  }

  // إذا كان Object
  if (
    typeof value ===
    "object"
  ) {
    if (
      typeof value.url ===
      "string"
    ) {
      return value;
    }

    if (
      typeof value.path ===
      "string"
    ) {
      return value;
    }

    for (
      const key of
      Object.keys(value)
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


// ======================================================
// تحميل ملف الصوت
// ======================================================

async function downloadAudio(
  baseUrl,
  audio
) {
  let audioUrl =
    null;

  // URL مباشر
  if (
    audio.url &&
    typeof audio.url ===
      "string"
  ) {
    audioUrl =
      audio.url;
  }

  // Path
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
