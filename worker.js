const CHATTERBOX_SPACE =
  "https://resembleai-chatterbox-multilingual-tts.hf.space";

const DENOISE_SPACE =
  "https://multimodalart-resemble-enhance-zerogpu.hf.space";

const MAX_TEXT_LENGTH = 2000;
const CHUNK_SIZE = 280;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // الصفحة الرئيسية
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Goku Voice AI is running.", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...corsHeaders()
        }
      });
    }

    // توليد الصوت
    if (request.method === "POST" && url.pathname === "/api/generate") {
      try {
        const form = await request.formData();

        const text = form.get("text");
        const language = form.get("language") || "en";
        const voice = form.get("voice");

        // =========================
        // التحقق من البيانات
        // =========================

        if (!text || typeof text !== "string") {
          return json(
            { error: "اكتب نصاً أولاً." },
            400
          );
        }

        if (!voice || typeof voice.arrayBuffer !== "function") {
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

        // =========================
        // تنظيف النص
        // =========================

        const cleanText = normalizeText(text, language);

        if (!cleanText) {
          return json(
            { error: "النص فارغ." },
            400
          );
        }

        // الحد الأقصى للموقع = 2000 حرف
        if (cleanText.length > MAX_TEXT_LENGTH) {
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

        const chunks = splitTextIntoChunks(
          cleanText,
          language
        );

        if (!chunks.length) {
          return json(
            { error: "لم يتم العثور على نص صالح." },
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
        // إزالة الضوضاء مرة واحدة فقط
        // =========================

        const denoisedVoice = await removeNoise(voice);

        // =========================
        // رفع الصوت المنظف إلى Chatterbox
        // =========================

        const chatterboxUpload = new FormData();

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

        const uploadResponse = await fetch(
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

        const audioPath = uploaded[0];

        // =========================
        // توليد جميع المقاطع
        // =========================

        const audioChunks = [];

        for (
          let i = 0;
          i < chunks.length;
          i++
        ) {
          const chunk = chunks[i];

          console.log(
            `Generating chunk ${i + 1}/${chunks.length}:`,
            chunk
          );

          const generatedAudio =
            await generateChatterboxAudio(
              chunk,
              language,
              audioPath
            );

          if (!generatedAudio) {
            throw new Error(
              `فشل توليد الجزء ${i + 1} من ${chunks.length}.`
            );
          }

          audioChunks.push(
            generatedAudio
          );
        }

        // =========================
        // دمج جميع ملفات WAV
        // =========================

        console.log(
          `Merging ${audioChunks.length} audio files...`
        );

        const finalAudio =
          mergeWavFiles(audioChunks);

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
              "Content-Type": "audio/wav",
              "Cache-Control": "no-store",
              "Access-Control-Allow-Origin": "*"
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
        headers: corsHeaders()
      }
    );
  }
};


function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

// ======================================================
// توليد مقطع واحد من Chatterbox
// ======================================================

async function generateChatterboxAudio(
  text,
  language,
  audioPath
) {
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
            text,
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

            // Exaggeration
            0.45,

            // Temperature
            0.60,

            // Seed
            0,

            // CFG: English should use 0 when the reference voice is not English.
            language === "en" ? 0 : language === "ar" ? 0.5 : 0.35
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

  let remaining = text.trim();

  while (remaining.length > 0) {
    // إذا كان النص المتبقي صغيراً بما يكفي
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(
        remaining.trim()
      );
      break;
    }

    // نأخذ أول 280 حرف تقريباً
    let cut =
      remaining.lastIndexOf(
        " ",
        CHUNK_SIZE
      );

    // نبحث أيضاً عن علامات الترقيم
    const punctuationPositions = [
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

    // اختر أقرب علامة ترقيم مناسبة
    // لكن لا نقطع في مكان صغير جداً
    for (
      const position
      of punctuationPositions
    ) {
      if (
        position > 100 &&
        position > cut
      ) {
        cut = position + 1;
      }
    }

    // إذا لم نجد مكاناً مناسباً
    if (
      cut <= 0 ||
      cut > CHUNK_SIZE
    ) {
      cut = CHUNK_SIZE;
    }

    const chunk =
      remaining
        .slice(0, cut)
        .trim();

    if (chunk) {
      chunks.push(chunk);
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

async function removeNoise(voice) {
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

            "Midpoint",

            64,

            0.5,

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


// ======================================================
// انتظار نتيجة Gradio SSE
// ======================================================

async function waitForSSEAudio(
  baseUrl,
  endpoint,
  eventId
) {
  const response = await fetch(
    `${baseUrl}/gradio_api/call/${endpoint}/${eventId}`,
    {
      method: "GET",
      headers: {
        "Accept": "text/event-stream"
      }
    }
  );

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {}

    const extra =
      body && body.length < 700
        ? `: ${body}`
        : "";

    throw new Error(
      `فشل الاتصال بنتيجة المعالجة (HTTP ${response.status})${extra}`
    );
  }

  const text = await response.text();

  if (!text || !text.trim()) {
    throw new Error(
      `خدمة ${endpoint} أعادت استجابة فارغة.`
    );
  }

  return parseCompletedSSE(
    text,
    baseUrl,
    endpoint
  );
}


// ======================================================
// تحليل SSE — متوافق مع صيغ Gradio المختلفة
// ======================================================

async function parseCompletedSSE(
  text,
  baseUrl,
  endpoint
) {
  // SSE يستخدم CRLF أو LF، لذلك نوحد الأسطر أولاً.
  const normalized = String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // كل حدث SSE مفصول بسطر فارغ.
  const blocks = normalized.split(/\n\s*\n/);

  let sawComplete = false;

  for (const block of blocks) {
    if (!block.trim()) {
      continue;
    }

    const lines = block.split("\n");

    let eventName = "";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (!eventName || dataLines.length === 0) {
      continue;
    }

    const rawData = dataLines.join("\n").trim();

    // =========================
    // اكتملت العملية
    // =========================

    if (eventName === "complete") {
      sawComplete = true;

      let parsed;

      try {
        parsed = JSON.parse(rawData);
      } catch (error) {
        throw new Error(
          `Chatterbox/Gradio أرسل نتيجة غير صالحة في حدث complete: ${rawData.slice(0, 700)}`
        );
      }

      const audio = findAudioFile(parsed);

      if (!audio) {
        // لا نخفي المشكلة الحقيقية.
        throw new Error(
          `اكتملت معالجة ${endpoint} لكن لم يتم العثور على ملف صوتي في الرد. الرد: ${JSON.stringify(parsed).slice(0, 1200)}`
        );
      }

      const downloaded = await downloadAudio(
        baseUrl,
        audio
      );

      if (!downloaded || downloaded.byteLength === 0) {
        throw new Error(
          `تم العثور على ملف صوتي من ${endpoint} لكن تعذر تنزيله.`
        );
      }

      return downloaded;
    }

    // =========================
    // حدث خطأ
    // =========================

    if (eventName === "error") {
      throw new Error(
        extractGradioError(rawData, endpoint)
      );
    }

    // heartbeat / queued / generating / progress
    // يتم تجاهلها حتى نصل إلى complete أو error.
  }

  if (!sawComplete) {
    throw new Error(
      `انتهت استجابة خدمة ${endpoint} بدون حدث complete أو error. الرد: ${normalized.slice(0, 1200)}`
    );
  }

  return null;
}


// ======================================================
// استخراج رسالة خطأ Gradio الحقيقية
// ======================================================

function extractGradioError(
  rawData,
  endpoint
) {
  let message = "";

  try {
    const parsed = JSON.parse(rawData);

    if (typeof parsed === "string") {
      message = parsed;
    } else if (parsed !== null && typeof parsed === "object") {
      message =
        parsed.message ||
        parsed.error ||
        parsed.detail ||
        parsed.title ||
        (
          parsed.error &&
          typeof parsed.error === "object" &&
          (
            parsed.error.message ||
            parsed.error.detail
          )
        ) ||
        "";

      if (!message) {
        message = JSON.stringify(parsed);
      }
    }
  } catch {
    message = rawData;
  }

  message = String(message || "").trim();

  if (!message) {
    message = "لم ترسل الخدمة سبب الخطأ.";
  }

  const lower = message.toLowerCase();

  if (
    lower.includes("queue") ||
    lower.includes("queue full")
  ) {
    return `خدمة ${endpoint} مشغولة حالياً. انتظر بضع ثوانٍ ثم أعد المحاولة. التفاصيل: ${message}`;
  }

  if (
    lower.includes("loading") ||
    lower.includes("sleeping") ||
    lower.includes("sleep")
  ) {
    return `خدمة ${endpoint} ما زالت تستيقظ أو تُحمّل النموذج. التفاصيل: ${message}`;
  }

  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return `تم تجاوز الحد المؤقت لخدمة ${endpoint}. التفاصيل: ${message}`;
  }

  return `خدمة ${endpoint} أعادت خطأ: ${message}`;
}


// ======================================================
// البحث عن ملف الصوت داخل جميع صيغ FileData
// ======================================================

function findAudioFile(value) {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAudioFile(item);

      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  // الصيغة المعتادة لـ Gradio FileData.
  if (
    typeof value.url === "string" &&
    value.url.trim()
  ) {
    return value;
  }

  if (
    typeof value.path === "string" &&
    value.path.trim()
  ) {
    return value;
  }

  // بعض الإصدارات قد تضع الملف داخل data/output/value.
  const preferredKeys = [
    "data",
    "output",
    "value",
    "audio",
    "file",
    "files"
  ];

  for (const key of preferredKeys) {
    if (
      Object.prototype.hasOwnProperty.call(
        value,
        key
      )
    ) {
      const found = findAudioFile(value[key]);

      if (found) {
        return found;
      }
    }
  }

  for (const key of Object.keys(value)) {
    if (preferredKeys.includes(key)) {
      continue;
    }

    const found = findAudioFile(
      value[key]
    );

    if (found) {
      return found;
    }
  }

  return null;
}


// ======================================================
// تحميل ملف الصوت من Gradio
// ======================================================

async function downloadAudio(
  baseUrl,
  audio
) {
  let audioUrl = null;

  if (
    audio &&
    typeof audio.url === "string" &&
    audio.url.trim()
  ) {
    audioUrl = audio.url.trim();

  } else if (
    audio &&
    typeof audio.path === "string" &&
    audio.path.trim()
  ) {
    const path = audio.path.trim();

    if (
      path.startsWith("http://") ||
      path.startsWith("https://")
    ) {
      audioUrl = path;
    } else {
      audioUrl =
        `${baseUrl}/gradio_api/file=` +
        encodeURIComponent(path);
    }
  }

  if (!audioUrl) {
    throw new Error(
      "ملف الصوت لا يحتوي على url أو path صالح."
    );
  }

  const response = await fetch(
    audioUrl,
    {
      method: "GET"
    }
  );

  if (!response.ok) {
    let body = "";

    try {
      body = await response.text();
    } catch {}

    const extra =
      body && body.length < 500
        ? `: ${body}`
        : "";

    throw new Error(
      `فشل تنزيل ملف الصوت (HTTP ${response.status})${extra}`
    );
  }

  const bytes =
    await response.arrayBuffer();

  if (!bytes || bytes.byteLength === 0) {
    throw new Error(
      "خدمة الصوت أعادت ملفاً فارغاً."
    );
  }

  return bytes;
}


// ======================================================
// البحث عن ملف الصوت داخل نتيجة Gradio
// ======================================================

function findAudioFile(value) {
  if (!value) {
    return null;
  }

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

    if (
      Array.isArray
