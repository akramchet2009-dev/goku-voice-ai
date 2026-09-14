const CHATTERBOX = "https://resembleai-chatterbox-multilingual-tts.hf.space";
const DENOISE = "https://multimodalart-resemble-enhance-zerogpu.hf.space";

const MAX_TEXT_LENGTH = 2000;
const CHUNK_SIZE = 220;
const CHUNK_DELAY_MS = 800;
const SILENCE_SECONDS = 0.35;
const MAX_RETRIES = 2;
const EXAGGERATION = 0.5;
const TEMPERATURE = 0.7;
const CFG_PACE = 0.7;

// ✅ رموز اللغات الصحيحة (ISO codes كما يعرّفها Chatterbox)
const SUPPORTED_LANGS = ["ar", "en", "ja"];

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

      if (!text || typeof text !== "string") return json({ error: "اكتب نصاً أولاً." }, 400);
      if (!voice || typeof voice === "string") return json({ error: "لم يتم إرسال عينة صوتية." }, 400);
      if (!SUPPORTED_LANGS.includes(language)) return json({ error: `اللغة ${language} غير مدعومة.` }, 400);

      const cleanText = normalizeText(text, language);
      if (!cleanText) return json({ error: "النص فارغ بعد التنظيف." }, 400);
      if (cleanText.length > MAX_TEXT_LENGTH) return json({ error: `الحد الأقصى ${MAX_TEXT_LENGTH} حرف.` }, 400);

      const chunks = splitTextIntoChunks(cleanText);
      if (!chunks.length) return json({ error: "لا يوجد نص صالح." }, 400);

      console.log(`Lang: ${language} | Chars: ${cleanText.length} | Chunks: ${chunks.length}`);

      // محاولة إزالة الضوضاء، وإذا فشلت نستخدم الصوت الأصلي
      let finalVoiceBytes;
      let finalVoiceName;
      try {
        const denoised = await removeNoise(voice);
        finalVoiceBytes = denoised.bytes;
        finalVoiceName = denoised.name;
        console.log("Denoise: OK");
      } catch (denoiseErr) {
        console.warn("Denoise failed, using original audio:", denoiseErr.message);
        finalVoiceBytes = await voice.arrayBuffer();
        finalVoiceName = voice.name || "input_audio.wav";
      }

      // رفع الصوت إلى Chatterbox
      const upForm = new FormData();
      upForm.append("files", new File([finalVoiceBytes], finalVoiceName, { type: "audio/wav" }));

      const upRes = await fetch(`${CHATTERBOX}/gradio_api/upload`, { method: "POST", body: upForm });
      if (!upRes.ok) {
        const t = await upRes.text();
        throw new Error(`فشل رفع الصوت إلى Chatterbox (${upRes.status}): ${t.slice(0, 200)}`);
      }

      const uploaded = await upRes.json();
      if (!Array.isArray(uploaded) || !uploaded[0]) throw new Error("Chatterbox لم يستقبل العينة.");
      const audioPath = uploaded[0];
      console.log("Upload OK, path:", audioPath);

      const audioChunks = [];
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars): "${chunks[i].slice(0, 60)}..."`);
        const audio = await generateChatterboxAudio(chunks[i], language, audioPath);
        if (!audio) throw new Error(`فشل توليد الجزء ${i + 1}.`);
        audioChunks.push(audio);
        if (i < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
      }

      const finalAudio = mergeWavFiles(audioChunks);
      if (!finalAudio) throw new Error("فشل دمج المقاطع.");

      console.log("Final audio OK.");

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
      return json({ error: error?.message || "حدث خطأ." }, 500);
    }
  }
};

async function generateChatterboxAudio(text, language, audioPath) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const payload = {
        data: [
          text,
          language,
          {
            path: audioPath,
            meta: { _type: "gradio.FileData" },
            orig_name: "clean_voice.wav"
          },
          EXAGGERATION,
          TEMPERATURE,
          0,
          CFG_PACE
        ]
      };

      console.log("Chatterbox payload:", JSON.stringify(payload).slice(0, 400));

      const res = await fetch(`${CHATTERBOX}/gradio_api/call/generate_tts_audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`Chatterbox POST ${res.status}:`, errText);
        throw new Error(`فشل بدء التوليد (${res.status}): ${errText.slice(0, 300)}`);
      }

      const data = await res.json();
      console.log("Chatterbox POST response:", JSON.stringify(data).slice(0, 300));

      if (!data.event_id) throw new Error("لا يوجد event_id.");

      const audio = await waitForSSEAudio(CHATTERBOX, "generate_tts_audio", data.event_id);
      if (!audio) throw new Error("لم يتم استلام صوت.");
      return audio;

    } catch (err) {
      lastError = err;
      console.warn(`محاولة ${attempt + 1} فشلت: ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(1500);
    }
  }

  throw lastError || new Error("فشل بعد كل المحاولات.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function splitTextIntoChunks(text) {
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(remaining.trim());
      break;
    }

    let cut = remaining.lastIndexOf(" ", CHUNK_SIZE);
    const puncts = [".", "!", "?", "؟", "،", ",", "؛", ";", "。", "！", "？"];

    for (const p of puncts) {
      const pos = remaining.lastIndexOf(p, CHUNK_SIZE);
      if (pos > 80 && pos > cut) cut = pos + 1;
    }

    if (cut <= 0 || cut > CHUNK_SIZE) cut = CHUNK_SIZE;

    const chunk = remaining.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cut).trim();
  }

  return chunks;
}

function normalizeText(text, lang) {
  if (!text) return "";
  let r = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
  if (lang === "ar") r = normalizeArabicText(r);
  return r;
}

function normalizeArabicText(text) {
  if (!text) return "";
  return text
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\s\.\,\!\?\؛\،\:\-\n]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function removeNoise(voice) {
  const originalBytes = await voice.arrayBuffer();
  const upForm = new FormData();
  upForm.append("files", new File([originalBytes], voice.name || "input_audio", { type: voice.type || "audio/wav" }));

  const upRes = await fetch(`${DENOISE}/gradio_api/upload`, { method: "POST", body: upForm });
  if (!upRes.ok) throw new Error("فشل رفع العينة لمزيل الضوضاء.");

  const uploaded = await upRes.json();
  if (!Array.isArray(uploaded) || !uploaded[0]) throw new Error("مزيل الضوضاء لم يستقبل العينة.");
  const audioPath = uploaded[0];

  const predRes = await fetch(`${DENOISE}/gradio_api/call/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [
        { path: audioPath, meta: { _type: "gradio.FileData" }, orig_name: voice.name || "input_audio" },
        "Midpoint",
        64,
        0.5,
        true
      ]
    })
  });

  if (!predRes.ok) throw new Error("فشل تشغيل مزيل الضوضاء.");
  const predData = await predRes.json();
  if (!predData.event_id) throw new Error("مزيل الضوضاء لم يُرجع event_id.");

  const clean = await waitForSSEAudio(DENOISE, "predict", predData.event_id);
  if (!clean) throw new Error("لم يتم العثور على الصوت المنظف.");

  return { bytes: clean, name: "clean_voice.wav" };
}

async function waitForSSEAudio(baseUrl, endpoint, eventId) {
  const res = await fetch(`${baseUrl}/gradio_api/call/${endpoint}/${eventId}`);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`فشل الاتصال (${res.status}): ${t.slice(0, 300)}`);
  }
  const text = await res.text();
  console.log(`SSE raw (first 500 chars): ${text.slice(0, 500)}`);
  return parseCompletedSSE(text, baseUrl);
}

async function parseCompletedSSE(text, baseUrl) {
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
        const audio = findAudioFile(data);
        if (!audio) return null;
        return await downloadAudio(baseUrl, audio);
      } catch (e) {
        console.error("SSE PARSE ERROR:", e);
        return null;
      }
    }

    if (eventName === "error") {
      console.error("CHATTERBOX ERROR EVENT. Raw SSE text:", text.slice(0, 1000));

      // إذا كانت rawData هي "null" حرفياً، فهذا يعني خطأً داخلياً في الخدمة
      if (!rawData || rawData === "null") {
        throw new Error(
          "نموذج الصوت رفض الطلب. جرّب: (1) عينة صوتية أقصر (5-15 ثانية)، (2) نص أقصر، (3) ارفع عينة بجودة أعلى، (4) أعد المحاولة بعد دقيقة."
        );
      }

      let message = rawData;
      try {
        const parsed = JSON.parse(rawData);
        if (typeof parsed === "string") message = parsed;
        else if (parsed && typeof parsed === "object") {
          if (typeof parsed.error === "string") message = parsed.error;
          else if (typeof parsed.message === "string") message = parsed.message;
          else if (Array.isArray(parsed) && parsed.length > 0) message = String(parsed[0]);
          else message = JSON.stringify(parsed);
        }
      } catch {}

      if (message.length > 400) message = message.slice(0, 400) + "...";
      throw new Error(message);
    }
  }

  return null;
}

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

async function downloadAudio(baseUrl, audio) {
  let audioUrl = null;

  if (audio.url && typeof audio.url === "string") {
    audioUrl = audio.url;
  } else if (audio.path && typeof audio.path === "string") {
    if (audio.path.startsWith("http")) {
      audioUrl = audio.path;
    } else {
      audioUrl = `${baseUrl}/gradio_api/file=` + encodeURIComponent(audio.path);
    }
  }

  if (!audioUrl) return null;

  const res = await fetch(audioUrl);
  if (!res.ok) return null;
  return await res.arrayBuffer();
}

function mergeWavFiles(wavBuffers) {
  if (!wavBuffers || wavBuffers.length === 0) return null;
  if (wavBuffers.length === 1) return wavBuffers[0];

  const infos = wavBuffers.map(parseWav);
  const first = infos[0];

  for (let i = 1; i < infos.length; i++) {
    const c = infos[i];
    if (
      c.audioFormat !== first.audioFormat ||
      c.numChannels !== first.numChannels ||
      c.sampleRate !== first.sampleRate ||
      c.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error("ملفات الصوت لها خصائص مختلفة.");
    }
  }

  const bps = first.bitsPerSample / 8;
  const silenceBytes = Math.floor(first.sampleRate * first.numChannels * bps * SILENCE_SECONDS);
  const totalSilence = silenceBytes * (infos.length - 1);

  let totalData = totalSilence;
  for (const info of infos) totalData += info.data.length;

  const fmt = first.fmtChunk;
  const outSize = 12 + 8 + fmt.length + 8 + totalData;
  const out = new ArrayBuffer(outSize);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  writeString(bytes, 0, "RIFF");
  view.setUint32(4, outSize - 8, true);
  writeString(bytes, 8, "WAVE");

  let offset = 12;

  writeString(bytes, offset, "fmt ");
  offset += 4;
  view.setUint32(offset, fmt.length, true);
  offset += 4;
  bytes.set(fmt, offset);
  offset += fmt.length;

  writeString(bytes, offset, "data");
  offset += 4;
  view.setUint32(offset, totalData, true);
  offset += 4;

  for (let i = 0; i < infos.length; i++) {
    bytes.set(infos[i].data, offset);
    offset += infos[i].data.length;
    if (i < infos.length - 1) offset += silenceBytes;
  }

  return out;
}

function parseWav(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (readString(bytes, 0, 4) !== "RIFF" || readString(bytes, 8, 4) !== "WAVE") {
    throw new Error("ليس WAV صالحاً.");
  }

  let offset = 12;
  let fmtChunk = null;
  let dataChunk = null;
  let audioFormat = null, numChannels = null, sampleRate = null, bitsPerSample = null;

  while (offset + 8 <= bytes.length) {
    const id = readString(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) break;

    if (id === "fmt ") {
      fmtChunk = bytes.slice(start, end);
      if (fmtChunk.length >= 16) {
        const fv = new DataView(fmtChunk.buffer, fmtChunk.byteOffset, fmtChunk.byteLength);
        audioFormat = fv.getUint16(0, true);
        numChannels = fv.getUint16(2, true);
        sampleRate = fv.getUint32(4, true);
        bitsPerSample = fv.getUint16(14, true);
      }
    }

    if (id === "data") dataChunk = bytes.slice(start, end);
    if (fmtChunk && dataChunk) break;

    offset = end + (size % 2);
  }

  if (!fmtChunk || !dataChunk) throw new Error("تعذر قراءة WAV.");

  return { fmtChunk, data: dataChunk, audioFormat, numChannels, sampleRate, bitsPerSample };
}

function writeString(bytes, offset, value) {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
}

function readString(bytes, offset, length) {
  let r = "";
  for (let i = 0; i < length; i++) r += String.fromCharCode(bytes[offset + i]);
  return r;
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
