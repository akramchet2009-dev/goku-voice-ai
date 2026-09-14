const CHATTERBOX_SPACE =
  "https://resembleai-chatterbox-multilingual-tts.hf.space";

const DENOISE_SPACE =
  "https://multimodalart-resemble-enhance-zerogpu.hf.space";

const MAX_TEXT_LENGTH = 2000;
const CHUNK_SIZE = 280;

const HTTP_TIMEOUT_MS = 120000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Goku Voice AI is running.", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...corsHeaders()
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

        if (!voice || typeof voice.arrayBuffer !== "function") {
          return json({ error: "لم يتم إرسال عينة صوتية." }, 400);
        }

        if (!["ar", "en", "ja"].includes(language)) {
          return json({ error: "اللغة غير مدعومة." }, 400);
        }

        const cleanText = normalizeText(text, language);
        if (!cleanText) {
          return json({ error: "النص فارغ." }, 400);
        }

        if (cleanText.length > MAX_TEXT_LENGTH) {
          return json(
            { error: `الحد الأقصى للنص هو ${MAX_TEXT_LENGTH} حرف.` },
            400
          );
        }

        const chunks = splitTextIntoChunks(cleanText, language);
        if (!chunks.length) {
          return json({ error: "لم يتم العثور على نص صالح." }, 400);
        }

        console.log(`Text length: ${cleanText.length}`);
        console.log(`Generating ${chunks.length} chunk(s)`);

        const denoisedVoice = await removeNoise(voice);
        if (!denoisedVoice || !denoisedVoice.bytes) {
          throw new Error("فشل تنظيف الصوت المدخل.");
        }

        const uploaded = await withRetry(async () => {
          const fd = new FormData();
          fd.append(
            "files",
            new File([denoisedVoice.bytes], "clean_voice.wav", {
              type: "audio/wav"
            })
          );

          const uploadResponse = await fetchWithTimeout(
            `${CHATTERBOX_SPACE}/gradio_api/upload`,
            { method: "POST", body: fd }
          );

          if (!uploadResponse.ok) {
            throw new Error(
              `فشل رفع الصوت إلى Chatterbox (HTTP ${uploadResponse.status}).`
            );
          }

          const result = await uploadResponse.json();
          if (!Array.isArray(result) || !result[0]) {
            throw new Error("Chatterbox لم يستقبل العينة.");
          }
          return result;
        }, "chatterbox-upload");

        const audioPath = uploaded[0];
        const audioChunks = [];

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          console.log(`Generating chunk ${i + 1}/${chunks.length}:`, chunk);

          const generatedAudio = await generateChatterboxAudio(
            chunk,
            language,
            audioPath
          );

          if (!generatedAudio) {
            throw new Error(
              `فشل توليد الجزء ${i + 1} من ${chunks.length}.`
            );
          }

          audioChunks.push(generatedAudio);
        }

        console.log(`Merging ${audioChunks.length} audio files...`);
        const finalAudio = mergeWavFiles(audioChunks);
        if (!finalAudio) {
          throw new Error("فشل دمج المقاطع الصوتية.");
        }

        console.log("Final audio generated successfully.");

        return new Response(finalAudio, {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (error) {
        console.error("GENERATION ERROR:", error);
        return json(
          { error: error?.message || "حدث خطأ أثناء معالجة الصوت." },
          500
        );
      }
    }

    return new Response("Not Found", {
      status: 404,
      headers: corsHeaders()
    });
  }
};

/* ======================================================
   أدوات عامة
====================================================== */

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientError(err) {
  const msg = String(err?.message || "").toLowerCase();
  if (/\b5\d{2}\b/.test(msg)) return true;
  return [
    "queue",
    "sleeping",
    "loading",
    "starting",
    "timeout",
    "timed out",
    "network",
    "failed to fetch",
    "connection",
    "econnreset",
    "broken pipe",
    "event not found",
    "rate limit",
    "429"
  ].some((p) => msg.includes(p));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("انتهت مهلة الاتصال بخدمة الصوت.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn, label) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`[${label}] محاولة ${attempt + 1} فشلت:`, err?.message);
      if (!isTransientError(err) || attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

/* ======================================================
   ✅ تنظيف النص (الدالة المفقودة)
====================================================== */
function normalizeText(text, language) {
  if (!text || typeof text !== "string") return "";

  let result = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // إزالة التشكيل للعربية
  if (language === "ar") {
    result = result.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "");
  }

  return result;
}

/* ======================================================
   تقسيم النص
====================================================== */
function splitTextIntoChunks(text, language) {
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(remaining.trim());
      break;
    }

    let cut = remaining.lastIndexOf(" ", CHUNK_SIZE);

    const punctuationPositions = [
      remaining.lastIndexOf(".", CHUNK_SIZE),
      remaining.lastIndexOf("!", CHUNK_SIZE),
      remaining.lastIndexOf("?", CHUNK_SIZE),
      remaining.lastIndexOf("؟", CHUNK_SIZE),
      remaining.lastIndexOf("،", CHUNK_SIZE),
      remaining.lastIndexOf(",", CHUNK_SIZE),
      remaining.lastIndexOf("؛", CHUNK_SIZE),
      remaining.lastIndexOf(";", CHUNK_SIZE),
      remaining.lastIndexOf("。", CHUNK_SIZE),
      remaining.lastIndexOf("！", CHUNK_SIZE),
      remaining.lastIndexOf("？", CHUNK_SIZE)
    ];

    for (const position of punctuationPositions) {
      if (position > 100 && position > cut) {
        cut = position + 1;
      }
    }

    if (cut <= 0 || cut > CHUNK_SIZE) {
      cut = CHUNK_SIZE;
    }

    const chunk = remaining.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);

    remaining = remaining.slice(cut).trim();
  }

  return chunks;
}

/* ======================================================
   توليد مقطع واحد من Chatterbox
====================================================== */
async function generateChatterboxAudio(text, language, audioPath) {
  return await withRetry(async () => {
    const generateResponse = await fetchWithTimeout(
      `${CHATTERBOX_SPACE}/gradio_api/call/generate_tts_audio`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [
            text,
            language,
            {
              path: audioPath,
              meta: { _type: "gradio.FileData" },
              orig_name: "clean_voice.wav"
            },
            0.45, // Exaggeration
            0.60, // Temperature
            0,    // Seed
            // CFG: English=0، Arabic=0.5، Japanese=0.35
            language === "en" ? 0 : language === "ar" ? 0.5 : 0.35
          ]
        })
      }
    );

    if (!generateResponse.ok) {
      throw new Error(
        `فشل بدء توليد الصوت (HTTP ${generateResponse.status}).`
      );
    }

    const generateData = await generateResponse.json();
    if (!generateData.event_id) {
      throw new Error("لم يتم الحصول على event_id.");
    }

    return await waitForSSEAudio(
      CHATTERBOX_SPACE,
      "generate_tts_audio",
      generateData.event_id
    );
  }, "chatterbox-generate");
}

/* ======================================================
   إزالة الضوضاء
====================================================== */
async function removeNoise(voice) {
  const originalBytes = await voice.arrayBuffer();
  const fileName = voice.name || "input_audio";
  const fileType = voice.type || "audio/wav";

  return await withRetry(async () => {
    const uploadForm = new FormData();
    uploadForm.append(
      "files",
      new File([originalBytes], fileName, { type: fileType })
    );

    const uploadResponse = await fetchWithTimeout(
      `${DENOISE_SPACE}/gradio_api/upload`,
      { method: "POST", body: uploadForm }
    );

    if (!uploadResponse.ok) {
      throw new Error(
        `فشل رفع العينة إلى مزيل الضوضاء (HTTP ${uploadResponse.status}).`
      );
    }

    const uploaded = await uploadResponse.json();
    if (!Array.isArray(uploaded) || !uploaded[0]) {
      throw new Error("مزيل الضوضاء لم يستقبل العينة.");
    }

    const predictResponse = await fetchWithTimeout(
      `${DENOISE_SPACE}/gradio_api/call/predict`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [
            {
              path: uploaded[0],
              meta: { _type: "gradio.FileData" },
              orig_name: fileName
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
        `فشل تشغيل مزيل الضوضاء (HTTP ${predictResponse.status}).`
      );
    }

    const predictData = await predictResponse.json();
    if (!predictData.event_id) {
      throw new Error("مزيل الضوضاء لم يُرجع event_id.");
    }

    const cleanAudio = await waitForSSEAudio(
      DENOISE_SPACE,
      "predict",
      predictData.event_id
    );

    if (!cleanAudio) {
      throw new Error("لم يتم العثور على الصوت المنظف.");
    }

    return { bytes: cleanAudio, name: "clean_voice.wav" };
  }, "removeNoise");
}

/* ======================================================
   انتظار نتيجة Gradio SSE
====================================================== */
async function waitForSSEAudio(baseUrl, endpoint, eventId) {
  const response = await fetchWithTimeout(
    `${baseUrl}/gradio_api/call/${endpoint}/${eventId}`,
    { headers: { Accept: "text/event-stream" } }
  );

  if (!response.ok) {
    throw new Error(
      `فشل الاتصال بنتيجة المعالجة (HTTP ${response.status}).`
    );
  }

  const text = await response.text();
  return await parseCompletedSSE(text, baseUrl, endpoint);
}

/* ======================================================
   تحليل SSE
====================================================== */
async function parseCompletedSSE(text, baseUrl, endpoint) {
  const blocks = text.split(/\n\n+/);

  for (const block of blocks) {
    const eventMatch = block.match(/(?:^|\n)event:\s*([^\n]+)/i);
    const dataMatch = block.match(/(?:^|\n)data:\s*([\s\S]+)/i);

    if (!eventMatch || !dataMatch) continue;

    const eventName = eventMatch[1].trim();
    const rawData = dataMatch[1].trim();

    if (eventName === "complete") {
      try {
        const data = JSON.parse(rawData);
        const audio = findAudioFile(data);
        if (!audio) return null;
        return await downloadAudio(baseUrl, audio);
      } catch (error) {
        console.error("SSE PARSE ERROR:", error);
        return null;
      }
    }

    if (eventName === "error") {
      throw new Error(extractErrorMessage(rawData, endpoint));
    }
  }

  return null;
}

function extractErrorMessage(rawData, endpoint) {
  let message = "خدمة الصوت أعادت خطأ.";
  try {
    const parsed = JSON.parse(rawData);
    if (typeof parsed === "string") {
      message = parsed;
    } else if (parsed && typeof parsed === "object") {
      message =
        parsed.message ||
        parsed.error ||
        parsed.detail ||
        parsed?.error?.message ||
        message;
    }
  } catch {
    if (rawData && rawData.length < 500) {
      message = rawData;
    }
  }

  const lower = String(message).toLowerCase();
  if (lower.includes("queue")) {
    return "الخدمة مشغولة حالياً، جرّب بعد لحظات. (queue full)";
  }
  if (lower.includes("sleep") || lower.includes("loading")) {
    return "الخدمة تستيقظ الآن، أعد المحاولة بعد بضع ثوانٍ.";
  }
  if (lower.includes("quota") || lower.includes("rate")) {
    return "تم تجاوز الحد المسموح مؤقتاً. انتظر قليلاً ثم أعد المحاولة.";
  }

  return message;
}

/* ======================================================
   البحث عن ملف الصوت داخل نتيجة Gradio
====================================================== */
function findAudioFile(value) {
  if (!value) return null;

  if (typeof value === "object") {
    if (typeof value.url === "string") return value;
    if (typeof value.path === "string") return value;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findAudioFile(item);
        if (found) return found;
      }
    }

    for (const key of Object.keys(value)) {
      const found = findAudioFile(value[key]);
      if (found) return found;
    }
  }

  return null;
}

/* ======================================================
   تحميل ملف الصوت
====================================================== */
async function downloadAudio(baseUrl, audio) {
  let audioUrl = null;

  if (audio.url && typeof audio.url === "string") {
    audioUrl = audio.url;
  } else if (audio.path && typeof audio.path === "string") {
    if (
      audio.path.startsWith("http://") ||
      audio.path.startsWith("https://")
    ) {
      audioUrl = audio.path;
    } else {
      audioUrl = `${baseUrl}/gradio_api/file=${encodeURIComponent(
        audio.path
      )}`;
    }
  }

  if (!audioUrl) return null;

  const response = await fetchWithTimeout(audioUrl);
  if (!response.ok) return null;

  return await response.arrayBuffer();
}

/* ======================================================
   دمج ملفات WAV
====================================================== */
function mergeWavFiles(wavBuffers) {
  if (!wavBuffers || wavBuffers.length === 0) return null;
  if (wavBuffers.length === 1) return wavBuffers[0];

  const wavInfos = wavBuffers.map(parseWav);
  const first = wavInfos[0];

  for (let i = 1; i < wavInfos.length; i++) {
    const current = wavInfos[i];
    if (
      current.audioFormat !== first.audioFormat ||
      current.numChannels !== first.numChannels ||
      current.sampleRate !== first.sampleRate ||
      current.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error(
        "ملفات الصوت الناتجة لها خصائص مختلفة ولا يمكن دمجها."
      );
    }
  }

  let totalDataSize = 0;
  for (const info of wavInfos) {
    totalDataSize += info.data.length;
  }

  const fmtChunk = first.fmtChunk;
  const outputSize = 12 + 8 + fmtChunk.length + 8 + totalDataSize;
  const output = new ArrayBuffer(outputSize);
  const view = new DataView(output);
  const bytes = new Uint8Array(output);

  writeString(bytes, 0, "RIFF");
  view.setUint32(4, outputSize - 8, true);
  writeString(bytes, 8, "WAVE");

  let offset = 12;

  writeString(bytes, offset, "fmt ");
  offset += 4;
  view.setUint32(offset, fmtChunk.length, true);
  offset += 4;
  bytes.set(fmtChunk, offset);
  offset += fmtChunk.length;

  writeString(bytes, offset, "data");
  offset += 4;
  view.setUint32(offset, totalDataSize, true);
  offset += 4;

  for (const info of wavInfos) {
    bytes.set(info.data, offset);
    offset += info.data.length;
  }

  return output;
}

/* ======================================================
   ✅ تحليل WAV (نسخة كاملة - كانت مقطوعة)
====================================================== */
function parseWav(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (
    readString(bytes, 0, 4) !== "RIFF" ||
    readString(bytes, 8, 4) !== "WAVE"
  ) {
    throw new Error("الملف الناتج ليس WAV صالحاً.");
  }

  let offset = 12;
  let fmtChunk = null;
  let dataChunk = null;
  let audioFormat = null;
  let numChannels = null;
  let sampleRate = null;
  let bitsPerSample = null;

  while (offset + 8 <= bytes.length) {
    const chunkId = readString(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > bytes.length) break;

    if (chunkId === "fmt ") {
      fmtChunk = bytes.slice(chunkStart, chunkEnd);

      if (fmtChunk.length >= 16) {
        const fmtView = new DataView(
          fmtChunk.buffer,
          fmtChunk.byteOffset,
          fmtChunk.byteLength
        );
        audioFormat = fmtView.getUint16(0, true);
        numChannels = fmtView.getUint16(2, true);
        sampleRate = fmtView.getUint32(4, true);
        bitsPerSample = fmtView.getUint16(14, true);
      }
    }

    if (chunkId === "data") {
      dataChunk = bytes.slice(chunkStart, chunkEnd);
    }

    offset = chunkEnd;
    // محاذاة RIFF للقطع الفردية
    if (chunkSize % 2 === 1) offset += 1;
  }

  if (!fmtChunk || !dataChunk) {
    throw new Error("ملف WAV ناقص (fmt أو data مفقود).");
  }

  return {
    fmtChunk,
    data: dataChunk,
    audioFormat,
    numChannels,
    sampleRate,
    bitsPerSample
  };
}

/* ======================================================
   ✅ قراءة / كتابة نصوص بايتية (الدالتان المفقودتان)
====================================================== */
function readString(bytes, offset, length) {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += String.fromCharCode(bytes[offset + i]);
  }
  return result;
}

function writeString(bytes, offset, str) {
  for (let i = 0; i < str.length; i++) {
    bytes[offset + i] = str.charCodeAt(i);
  }
      }
