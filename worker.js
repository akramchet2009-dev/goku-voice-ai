const HF_SPACE =
  "https://resembleai-chatterbox-multilingual-tts.hf.space";

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
    if (request.method === "POST" && url.pathname === "/api/generate") {
      try {
        const form = await request.formData();

        const originalText = form.get("text");
        const language = form.get("language") || "en";
        const voice = form.get("voice");

        if (!originalText || typeof originalText !== "string") {
          return json({ error: "اكتب نصاً أولاً." }, 400);
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

        // ------------------------------------------------
        // تنظيف النص وتحسين علامات الترقيم
        // ------------------------------------------------

        let cleanText = originalText
          .replace(/\r?\n+/g, " ")
          .replace(/[ \t]+/g, " ")
          .trim();

        // الإنجليزية:
        // إضافة مسافة بعد ! ? . , : ; إذا كانت مفقودة
        // مثال:
        // Hey!it's me!Goku!
        // يصبح:
        // Hey! it's me! Goku!
        if (language === "en") {
          cleanText = cleanText
            .replace(/([!?.,:;])([A-Za-z])/g, "$1 $2")
            .replace(/([A-Za-z])([!?.,:;])/g, "$1$2")
            .replace(/\s+([!?.,:;])/g, "$1")
            .replace(/([!?.,:;])\s{2,}/g, "$1 ");
        }

        // العربية:
        // لا نضيف علامات أو مسافات غريبة.
        // فقط نرتب المسافات.
        if (language === "ar") {
          cleanText = cleanText
            .replace(/\s+([،؛؟!.,])/g, "$1")
            .replace(/([،؛؟!])([^\s])/g, "$1 $2")
            .replace(/[ \t]+/g, " ")
            .trim();
        }

        // الحد الأقصى الرسمي للنص
        cleanText = cleanText.slice(0, 300);

        if (!cleanText) {
          return json(
            { error: "النص فارغ." },
            400
          );
        }

        // ------------------------------------------------
        // 1. رفع عينة الصوت
        // ------------------------------------------------

        const uploadForm = new FormData();

        uploadForm.append(
          "files",
          voice,
          voice.name || "voice.wav"
        );

        const uploadResponse = await fetch(
          `${HF_SPACE}/gradio_api/upload`,
          {
            method: "POST",
            body: uploadForm
          }
        );

        if (!uploadResponse.ok) {
          const errorText =
            await uploadResponse.text();

          return json(
            {
              error: "فشل رفع عينة الصوت.",
              details: errorText
            },
            500
          );
        }

        const uploaded =
          await uploadResponse.json();

        if (
          !Array.isArray(uploaded) ||
          !uploaded[0]
        ) {
          return json(
            {
              error:
                "لم يتم الحصول على مسار عينة الصوت."
            },
            500
          );
        }

        const audioPath = uploaded[0];

        // ------------------------------------------------
        // 2. إرسال طلب التوليد
        // ------------------------------------------------

        const generateResponse = await fetch(
          `${HF_SPACE}/gradio_api/call/generate_tts_audio`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },

            body: JSON.stringify({
              data: [
                cleanText,

                // اللغة
                language,

                // عينة الصوت
                {
                  path: audioPath,
                  meta: {
                    _type: "gradio.FileData"
                  },
                  orig_name:
                    voice.name || "voice.wav"
                },

                // ------------------------------------------------
                // إعدادات Chatterbox
                // ------------------------------------------------

                // Exaggeration
                // القيمة الرسمية المحايدة تقريباً
                0.50,

                // Temperature
                // أقل قليلاً من الافتراضي لتقليل العشوائية
                0.75,

                // Seed
                // 0 = نتيجة عشوائية جديدة
                0,

                // CFG / Pace
                // القيمة الرسمية العامة
                0.50
              ]
            })
          }
        );

        if (!generateResponse.ok) {
          const errorText =
            await generateResponse.text();

          return json(
            {
              error:
                "فشل إرسال طلب توليد الصوت.",
              details: errorText
            },
            500
          );
        }

        const generateData =
          await generateResponse.json();

        const eventId =
          generateData.event_id;

        if (!eventId) {
          return json(
            {
              error:
                "لم يتم الحصول على رقم المهمة."
            },
            500
          );
        }

        // ------------------------------------------------
        // 3. انتظار النتيجة
        // ------------------------------------------------

        const resultResponse = await fetch(
          `${HF_SPACE}/gradio_api/call/generate_tts_audio/${eventId}`
        );

        if (!resultResponse.ok) {
          const errorText =
            await resultResponse.text();

          return json(
            {
              error:
                "فشل الحصول على نتيجة التوليد.",
              details: errorText
            },
            500
          );
        }

        const resultText =
          await resultResponse.text();

        // ------------------------------------------------
        // 4. قراءة SSE
        // ------------------------------------------------

        const lines =
          resultText.split("\n");

        let audioData = null;

        for (const line of lines) {
          if (!line.startsWith("data:")) {
            continue;
          }

          const data =
            line.slice(5).trim();

          if (!data || data === "null") {
            continue;
          }

          try {
            const parsed =
              JSON.parse(data);

            if (
              Array.isArray(parsed) &&
              parsed.length > 0
            ) {
              audioData = parsed[0];
            }
          } catch (_) {
            // تجاهل أسطر SSE غير JSON
          }
        }

        if (!audioData) {
          return json(
            {
              error:
                "لم يتم العثور على ملف الصوت الناتج."
            },
            500
          );
        }

        // ------------------------------------------------
        // 5. استخراج رابط الصوت
        // ------------------------------------------------

        let audioURL = null;

        if (typeof audioData === "string") {
          audioURL = audioData;
        } else if (audioData.url) {
          audioURL = audioData.url;
        } else if (audioData.path) {
          audioURL =
            `${HF_SPACE}/gradio_api/file=${encodeURIComponent(
              audioData.path
            )}`;
        }

        if (!audioURL) {
          return json(
            {
              error:
                "رابط الصوت الناتج غير موجود."
            },
            500
          );
        }

        // إذا كان الرابط نسبياً
        if (audioURL.startsWith("/")) {
          audioURL =
            `${HF_SPACE}${audioURL}`;
        }

        // ------------------------------------------------
        // 6. تنزيل الصوت وإرساله للموقع
        // ------------------------------------------------

        const audioResponse =
          await fetch(audioURL);

        if (!audioResponse.ok) {
          return json(
            {
              error:
                "تعذر تنزيل الصوت الناتج."
            },
            500
          );
        }

        return new Response(
          audioResponse.body,
          {
            status: 200,
            headers: {
              "Content-Type":
                audioResponse.headers.get(
                  "Content-Type"
                ) || "audio/wav",

              "Cache-Control":
                "no-store"
            }
          }
        );

      } catch (error) {
        return json(
          {
            error:
              "حدث خطأ داخل Worker.",
            details:
              error?.message ||
              String(error)
          },
          500
        );
      }
    }

    return new Response(
      "Not Found",
      {
        status: 404
      }
    );
  }
};


// ------------------------------------------------
// JSON helper
// ------------------------------------------------

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
