const CHATTERBOX_SPACE =
  "https://resembleai-chatterbox-multilingual-tts.hf.space";

const DENOISE_SPACE =
  "https://multimodalart-resemble-enhance-zerogpu.hf.space";

const MAX_GENERATION_ATTEMPTS = 3;
const MAX_DENOISE_ATTEMPTS = 2;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =====================================================
    // اختبار Worker
    // =====================================================

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Goku Voice AI is running.", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    }

    // =====================================================
    // توليد الصوت
    // =====================================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/generate"
    ) {
      try {
        const form = await request.formData();

        const text = form.get("text");
        const language = form.get("language") || "en";
        const voice = form.get("voice");

        // -------------------------------------------------
        // التحقق من المدخلات
        // -------------------------------------------------

        if (!text || typeof text !== "string") {
          return json(
            {
              error: "اكتب نصاً أولاً."
            },
            400
          );
        }

        if (!voice || typeof voice === "string") {
          return json(
            {
              error: "لم يتم إرسال عينة صوتية."
            },
            400
          );
        }

        if (!["ar", "en", "ja"].includes(language)) {
          return json(
            {
              error: "اللغة غير مدعومة."
            },
            400
          );
        }

        const cleanText =
          normalizeText(text, language);

        if (!cleanText) {
          return json(
            {
              error: "النص فارغ."
            },
            400
          );
        }

        // =================================================
        // إزالة الضوضاء مع إعادة المحاولة
        // =================================================

        const denoisedVoice =
          await removeNoiseWithRetry(voice);

        // =================================================
        // رفع الصوت المنظف إلى Chatterbox
        // =================================================

        const audioPath =
          await uploadToChatterbox(
            denoisedVoice.bytes
          );

        // =================================================
        // توليد الصوت مع إعادة المحاولة
        // =================================================

        const generatedAudio =
          await generateWithRetry(
            cleanText,
            language,
            audioPath
          );

        if (!generatedAudio) {
          throw new Error(
            "لم يتم الحصول على الصوت الناتج."
          );
        }

        return new Response(
          generatedAudio,
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
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  }
};


// =====================================================
// إزالة الضوضاء مع إعادة المحاولة
// =====================================================

async function removeNoiseWithRetry(voice) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_DENOISE_ATTEMPTS;
    attempt++
  ) {
    try {
      console.log(
        `DENOISE ATTEMPT ${attempt}/${MAX_DENOISE_ATTEMPTS}`
      );

      return await removeNoise(voice);

    } catch (error) {
      lastError = error;

      console.error(
        `DENOISE ATTEMPT ${attempt} FAILED:`,
        error
      );

      if (
        attempt < MAX_DENOISE_ATTEMPTS
      ) {
        await sleep(1500);
      }
    }
  }

  throw new Error(
    "فشل تنظيف العينة الصوتية بعد عدة محاولات: " +
    (
      lastError?.message ||
      "خطأ غير معروف"
    )
  );
}


// =====================================================
// إزالة الضوضاء
// =====================================================

async function removeNoise(voice) {
  const bytes =
    await voice.arrayBuffer();

  const uploadForm =
    new FormData();

  uploadForm.append(
    "files",
    new File(
      [bytes],
      voice.name ||
        "input_audio.wav",
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
    const details =
      await safeResponseText(
        uploadResponse
      );

    throw new Error(
      "فشل رفع العينة إلى مزيل الضوضاء." +
      (
        details
          ? ` (${details})`
          : ""
      )
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
                "input_audio.wav"
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
    const details =
      await safeResponseText(
        predictResponse
      );

    throw new Error(
      "فشل تشغيل مزيل الضوضاء." +
      (
        details
          ? ` (${details})`
          : ""
      )
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


// =====================================================
// رفع الصوت إلى Chatterbox
// =====================================================

async function uploadToChatterbox(
  audioBytes
) {
  const uniqueName =
    `clean_voice_${randomId()}.wav`;

  const uploadForm =
    new FormData();

  uploadForm.append(
    "files",
    new File(
      [audioBytes],
      uniqueName,
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
        body: uploadForm
      }
    );

  if (!uploadResponse.ok) {
    const details =
      await safeResponseText(
        uploadResponse
      );

    throw new Error(
      "فشل رفع الصوت إلى Chatterbox." +
      (
        details
          ? ` (${details})`
          : ""
      )
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

  return uploaded[0];
}


// =====================================================
// توليد الصوت مع إعادة المحاولة
// =====================================================

async function generateWithRetry(
  text,
  language,
  audioPath
) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_GENERATION_ATTEMPTS;
    attempt++
  ) {
    try {
      console.log(
        `GENERATION ATTEMPT ${attempt}/${MAX_GENERATION_ATTEMPTS}`
      );

      return await generateOnce(
        text,
        language,
        audioPath
      );

    } catch (error) {
      lastError = error;

      console.error(
        `GENERATION ATTEMPT ${attempt} FAILED:`,
        error
      );

      if (
        attempt < MAX_GENERATION_ATTEMPTS
      ) {
        await sleep(2000);
      }
    }
  }

  throw new Error(
    "فشل توليد الصوت بعد عدة محاولات: " +
    (
      lastError?.message ||
      "خطأ غير معروف"
    )
  );
}


// =====================================================
// محاولة توليد واحدة
// =====================================================

async function generateOnce(
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

            // exaggeration
            0.45,

            // temperature
            0.60,

            // seed
            0,

            // cfg
            0.35
          ]
        })
      }
    );

  if (!generateResponse.ok) {
    const details =
      await safeResponseText(
        generateResponse
      );

    throw new Error(
      "فشل بدء توليد الصوت." +
      (
        details
          ? ` (${details})`
          : ""
      )
    );
  }

  const generateData =
    await generateResponse.json();

  if (!generateData.event_id) {
    throw new Error(
      "لم يتم الحصول على event_id من Chatterbox."
    );
  }

  console.log(
    "EVENT ID:",
    generateData.event_id
  );

  const generatedAudio =
    await waitForSSEAudio(
      CHATTERBOX_SPACE,
      "generate_tts_audio",
      generateData.event_id
    );

  if (!generatedAudio) {
    throw new Error(
      "Chatterbox أنهى الطلب ولكن لم يُرجع ملف صوت."
    );
  }

  return generatedAudio;
}


// =====================================================
// انتظار نتيجة SSE
// =====================================================

async function waitForSSEAudio(
  baseUrl,
  endpoint,
  eventId
) {
  const response =
    await fetch(
      `${baseUrl}/gradio_api/call/${endpoint}/${encodeURIComponent(eventId)}`,
      {
        method: "GET",
        headers: {
          "Accept":
            "text/event-stream",
          "Cache-Control":
            "no-cache"
        }
      }
    );

  if (!response.ok) {
    const details =
      await safeResponseText(
        response
      );

    throw new Error(
      "فشل الاتصال بنتيجة المعالجة." +
      (
        details
          ? ` (${details})`
          : ""
      )
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
// تحليل SSE
// =====================================================

async function parseCompletedSSE(
  text,
  baseUrl
) {
  const blocks =
    text.split(/\n\s*\n/);

  let lastError = null;

  for (const block of blocks) {
    if (!block.trim()) {
      continue;
    }

    const eventMatch =
      block.match(
        /(?:^|\n)event:\s*([^\n\r]+)/i
      );

    if (!eventMatch) {
      continue;
    }

    const eventName =
      eventMatch[1].trim();

    const dataMatch =
      block.match(
        /(?:^|\n)data:\s*([\s\S]*?)(?:\r?\n|$)/i
      );

    if (!dataMatch) {
      continue;
    }

    const rawData =
      dataMatch[1].trim();

    if (
      eventName === "heartbeat" ||
      eventName === "generating"
    ) {
      continue;
    }

    // -------------------------------------------------
    // خطأ من Gradio
    // -------------------------------------------------

    if (eventName === "error") {
      lastError =
        extractGradioError(rawData);

      throw new Error(
        lastError ||
        "Chatterbox أعاد خطأ أثناء توليد الصوت."
      );
    }

    // -------------------------------------------------
    // النتيجة النهائية
    // -------------------------------------------------

    if (eventName === "complete") {
      let data;

      try {
        data =
          JSON.parse(rawData);
      } catch (error) {
        throw new Error(
          "تعذر قراءة النتيجة النهائية من Gradio."
        );
      }

      const audio =
        findAudioFile(data);

      if (!audio) {
        throw new Error(
          "اكتملت العملية لكن لم يتم العثور على ملف الصوت."
        );
      }

      const downloaded =
        await downloadAudio(
          baseUrl,
          audio
        );

      if (!downloaded) {
        throw new Error(
          "تم العثور على ملف الصوت لكن تعذر تحميله."
        );
      }

      return downloaded;
    }
  }

  if (lastError) {
    throw new Error(lastError);
  }

  throw new Error(
    "انتهت استجابة Gradio بدون نتيجة صوتية."
  );
}


// =====================================================
// استخراج رسالة خطأ Gradio
// =====================================================

function extractGradioError(
  rawData
) {
  try {
    const data =
      JSON.parse(rawData);

    if (typeof data === "string") {
      return data;
    }

    if (
      data &&
      typeof data.error === "string"
    ) {
      return data.error;
    }

    if (
      data &&
      typeof data.message === "string"
    ) {
      return data.message;
    }

    if (
      data &&
      typeof data.detail === "string"
    ) {
      return data.detail;
    }

    return JSON.stringify(data);

  } catch {
    return rawData
      .replace(/^"|"$/g, "")
      .trim();
  }
}


// =====================================================
// البحث عن ملف الصوت
// =====================================================

function findAudioFile(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {

    if (
      typeof value.url === "string"
    ) {
      return value;
    }

    if (
      typeof value.path === "string"
    ) {
      return value;
    }

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
// تحميل الصوت
// =====================================================

async function downloadAudio(
  baseUrl,
  audio
) {
  let audioUrl = null;

  if (
    audio.url &&
    typeof audio.url === "string"
  ) {
    audioUrl =
      audio.url;
  }

  else if (
    audio.path &&
    typeof audio.path === "string"
  ) {
    if (
      audio.path.startsWith("http://") ||
      audio.path.startsWith("https://")
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
    const details =
      await safeResponseText(
        response
      );

    throw new Error(
      "تعذر تحميل الصوت الناتج." +
      (
        details
          ? ` (${details})`
          : ""
      )
    );
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
// أدوات مساعدة
// =====================================================

function randomId() {
  return (
    Date.now().toString(36) +
    "_" +
    Math.random()
      .toString(36)
      .slice(2, 10)
  );
}


function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


async function safeResponseText(
  response
) {
  try {
    const text =
      await response.text();

    return text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);

  } catch {
    return "";
  }
}


// =====================================================
// JSON RESPONSE
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
          "*",

        "Cache-Control":
          "no-store"
      }
    }
  );
          }
