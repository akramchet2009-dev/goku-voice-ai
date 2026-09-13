const CHATTERBOX_SPACE =
  "https://resembleai-chatterbox-multilingual-tts.hf.space";

const DENOISE_SPACE =
  "https://multimodalart-resemble-enhance-zerogpu.hf.space";


export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    /*
     * ==========================================
     * HOME
     * ==========================================
     */

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return new Response(
        "Goku Voice AI is running.",
        {
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }


    /*
     * ==========================================
     * GENERATE
     * ==========================================
     */

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


        /*
         * Validate text
         */

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


        /*
         * Validate voice
         */

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


        /*
         * Validate language
         */

        if (
          !["ar", "en", "ja"]
            .includes(language)
        ) {

          return json(
            {
              error:
                "اللغة غير مدعومة."
            },
            400
          );

        }


        /*
         * Normalize text
         */

        const cleanText =
          normalizeText(
            text,
            language
          );


        /*
         * ==========================================
         * AI DENOISE
         * ==========================================
         */

        const denoisedVoice =
          await removeNoiseWithRetry(
            voice
          );


        /*
         * ==========================================
         * UPLOAD CLEAN AUDIO TO CHATTERBOX
         * ==========================================
         */

        const audioPath =
          await uploadToChatterbox(
            denoisedVoice.bytes
          );


        /*
         * ==========================================
         * GENERATE AUDIO
         * ==========================================
         *
         * We retry with a completely new event
         * if the first generation fails.
         */

        const generatedAudio =
          await generateWithRetry(
            cleanText,
            language,
            audioPath
          );


        /*
         * ==========================================
         * RETURN AUDIO
         * ==========================================
         */

        return new Response(
          generatedAudio,
          {
            status: 200,

            headers: {
              "Content-Type":
                "audio/wav",

              "Cache-Control":
                "no-store, no-cache, must-revalidate",

              "Pragma":
                "no-cache",

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


    /*
     * ==========================================
     * NOT FOUND
     * ==========================================
     */

    return new Response(
      "Not Found",
      {
        status: 404
      }
    );

  }
};


/*
 * =========================================================
 * UPLOAD TO CHATTERBOX
 * =========================================================
 */

async function uploadToChatterbox(
  audioBytes
) {

  const uniqueName =
    "clean_voice_" +
    randomId() +
    ".wav";


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


  const response =
    await fetch(
      `${CHATTERBOX_SPACE}/gradio_api/upload`,
      {
        method: "POST",
        body: uploadForm,
        cache: "no-store"
      }
    );


  if (!response.ok) {

    const details =
      await safeResponseText(
        response
      );

    throw new Error(
      "فشل رفع الصوت إلى Chatterbox." +
      (
        details
          ? " " + details
          : ""
      )
    );

  }


  const data =
    await response.json();


  if (
    !Array.isArray(data) ||
    !data[0]
  ) {

    throw new Error(
      "Chatterbox لم يستقبل العينة الصوتية."
    );

  }


  return data[0];

}


/*
 * =========================================================
 * GENERATE WITH RETRY
 * =========================================================
 */

async function generateWithRetry(
  text,
  language,
  audioPath
) {

  let lastError =
    null;


  /*
   * Try up to 3 times.
   */

  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {

    try {

      console.log(
        `Chatterbox generation attempt ${attempt}/3`
      );


      const generated =
        await generateOnce(
          text,
          language,
          audioPath
        );


      if (generated) {

        return generated;

      }


      throw new Error(
        "لم يتم العثور على الصوت الناتج."
      );


    } catch (error) {

      lastError =
        error;


      console.error(
        `Generation attempt ${attempt} failed:`,
        error
      );


      /*
       * Wait before retrying.
       */

      if (attempt < 3) {

        await sleep(
          1500 * attempt
        );

      }

    }

  }


  throw new Error(
    lastError?.message ||
    "فشل توليد الصوت بعد عدة محاولات."
  );

}


/*
 * =========================================================
 * GENERATE ONCE
 * =========================================================
 */

async function generateOnce(
  text,
  language,
  audioPath
) {

  /*
   * Fresh settings for every request.
   *
   * These are intentionally stable rather
   * than aggressive.
   */

  const exaggeration =
    0.45;

  const temperature =
    0.60;

  const seed =
    0;

  const cfg =
    0.35;


  /*
   * Start Gradio job
   */

  const response =
    await fetch(
      `${CHATTERBOX_SPACE}/gradio_api/call/generate_tts_audio`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Cache-Control":
            "no-cache"
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

            exaggeration,

            temperature,

            seed,

            cfg

          ]

        })
      }
    );


  if (!response.ok) {

    const details =
      await safeResponseText(
        response
      );


    throw new Error(
      "فشل بدء توليد الصوت." +
      (
        details
          ? " " + details
          : ""
      )
    );

  }


  const data =
    await response.json();


  if (
    !data ||
    !data.event_id
  ) {

    throw new Error(
      "Chatterbox لم يُرجع event_id."
    );

  }


  /*
   * IMPORTANT:
   *
   * Every generation gets its own
   * event_id and its own SSE request.
   */

  return await waitForSSEAudio(
    CHATTERBOX_SPACE,
    "generate_tts_audio",
    data.event_id
  );

}


/*
 * =========================================================
 * AI DENOISE WITH RETRY
 * =========================================================
 */

async function removeNoiseWithRetry(
  voice
) {

  let lastError =
    null;


  for (
    let attempt = 1;
    attempt <= 2;
    attempt++
  ) {

    try {

      return await removeNoise(
        voice
      );

    } catch (error) {

      lastError =
        error;


      console.error(
        `Denoise attempt ${attempt} failed:`,
        error
      );


      if (attempt < 2) {

        await sleep(1000);

      }

    }

  }


  throw new Error(
    lastError?.message ||
    "فشل تنظيف الصوت."
  );

}


/*
 * =========================================================
 * AI DENOISE
 * =========================================================
 */

async function removeNoise(
  voice
) {

  const bytes =
    await voice.arrayBuffer();


  const uniqueName =
    "input_" +
    randomId() +
    ".wav";


  /*
   * Upload to denoiser
   */

  const uploadForm =
    new FormData();


  uploadForm.append(
    "files",
    new File(
      [bytes],
      uniqueName,
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
        body: uploadForm,
        cache: "no-store"
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
          ? " " + details
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


  /*
   * Start denoise job
   */

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
                uniqueName
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
          ? " " + details
          : ""
      )
    );

  }


  const predictData =
    await predictResponse.json();


  if (
    !predictData ||
    !predictData.event_id
  ) {

    throw new Error(
      "مزيل الضوضاء لم يُرجع event_id."
    );

  }


  /*
   * Wait for denoised audio
   */

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


/*
 * =========================================================
 * SSE WAIT
 * =========================================================
 */

async function waitForSSEAudio(
  baseUrl,
  endpoint,
  eventId
) {

  const response =
    await fetch(
      `${baseUrl}/gradio_api/call/${endpoint}/${eventId}`,
      {
        method: "GET",

        headers: {
          "Accept":
            "text/event-stream",

          "Cache-Control":
            "no-cache"
        },

        cache: "no-store"
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
          ? " " + details
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


/*
 * =========================================================
 * PARSE SSE
 * =========================================================
 */

async function parseCompletedSSE(
  text,
  baseUrl
) {

  const blocks =
    text.split(
      /\r?\n\r?\n+/
    );


  let lastError =
    null;


  for (
    const block of blocks
  ) {

    const eventMatch =
      block.match(
        /(?:^|\r?\n)event:\s*([^\r\n]+)/i
      );


    const dataMatch =
      block.match(
        /(?:^|\r?\n)data:\s*([\s\S]*?)(?=\r?\n(?:event:|data:)|$)/i
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


    /*
     * COMPLETE
     */

    if (
      eventName === "complete"
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
            "اكتملت العملية لكن لم يتم العثور على ملف الصوت."
          );

        }


        const result =
          await downloadAudio(
            baseUrl,
            audio
          );


        if (!result) {

          throw new Error(
            "تم العثور على الصوت لكن تعذر تحميله."
          );

        }


        return result;

      } catch (error) {

        throw new Error(
          error?.message ||
          "تعذر قراءة نتيجة الصوت."
        );

      }

    }


    /*
     * ERROR
     */

    if (
      eventName === "error"
    ) {

      lastError =
        parseGradioError(
          rawData
        );

    }

  }


  if (lastError) {

    throw new Error(
      lastError
    );

  }


  throw new Error(
    "لم تُرجع خدمة الصوت نتيجة مكتملة."
  );

}


/*
 * =========================================================
 * GRADIO ERROR
 * =========================================================
 */

function parseGradioError(
  rawData
) {

  try {

    const parsed =
      JSON.parse(
        rawData
      );


    if (
      typeof parsed === "string"
    ) {

      return parsed;

    }


    if (
      parsed &&
      typeof parsed.error === "string"
    ) {

      return parsed.error;

    }


    if (
      parsed &&
      typeof parsed.message === "string"
    ) {

      return parsed.message;

    }


    return JSON.stringify(
      parsed
    );

  } catch (_) {

    return rawData ||
      "خدمة الصوت أعادت خطأ.";

  }

}


/*
 * =========================================================
 * FIND AUDIO
 * =========================================================
 */

function findAudioFile(
  value
) {

  if (!value) {
    return null;
  }


  /*
   * Object
   */

  if (
    typeof value === "object"
  ) {

    /*
     * URL
     */

    if (
      typeof value.url ===
      "string"
    ) {

      return value;

    }


    /*
     * Path
     */

    if (
      typeof value.path ===
      "string"
    ) {

      return value;

    }


    /*
     * Array
     */

    if (
      Array.isArray(value)
    ) {

      for (
        const item of value
      ) {

        const found =
          findAudioFile(
            item
          );


        if (found) {

          return found;

        }

      }

    }


    /*
     * Nested object
     */

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


/*
 * =========================================================
 * DOWNLOAD AUDIO
 * =========================================================
 */

async function downloadAudio(
  baseUrl,
  audio
) {

  let audioUrl =
    null;


  /*
   * Direct URL
   */

  if (
    audio.url &&
    typeof audio.url ===
      "string"
  ) {

    audioUrl =
      audio.url;

  }


  /*
   * Path
   */

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
    await fetch(
      audioUrl,
      {
        method: "GET",
        cache: "no-store"
      }
    );


  if (!response.ok) {

    return null;

  }


  const contentType =
    response.headers.get(
      "content-type"
    ) || "";


  /*
   * Sometimes an error page is returned
   * instead of the audio.
   */

  if (
    contentType.includes(
      "text/html"
    ) ||
    contentType.includes(
      "application/json"
    )
  ) {

    return null;

  }


  return await response.arrayBuffer();

}


/*
 * =========================================================
 * TEXT NORMALIZATION
 * =========================================================
 */

function normalizeText(
  text,
  language
) {

  let result =
    text
      .trim()
      .slice(0, 300);


  /*
   * English
   */

  if (
    language === "en"
  ) {

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


  /*
   * Arabic
   */

  if (
    language === "ar"
  ) {

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


  /*
   * Japanese
   */

  if (
    language === "ja"
  ) {

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


/*
 * =========================================================
 * RANDOM ID
 * =========================================================
 */

function randomId() {

  if (
    typeof crypto !==
      "undefined" &&
    typeof crypto.randomUUID ===
      "function"
  ) {

    return crypto.randomUUID();

  }


  return (
    Date.now().toString(36) +
    "_" +
    Math.random()
      .toString(36)
      .slice(2)
  );

}


/*
 * =========================================================
 * SLEEP
 * =========================================================
 */

function sleep(
  milliseconds
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        milliseconds
      )
  );

}


/*
 * =========================================================
 * SAFE RESPONSE TEXT
 * =========================================================
 */

async function safeResponseText(
  response
) {

  try {

    const text =
      await response.text();


    if (
      text &&
      text.length < 1000
    ) {

      return text;

    }

  } catch (_) {}


  return "";

}


/*
 * =========================================================
 * JSON RESPONSE
 * =========================================================
 */

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
