// api/analyze.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // جلب المفتاح المحفوظ بآمان في Vercel
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'مفتاح GEMINI_API_KEY غير معرّف في Vercel Environment Variables.' });
    }

    const { csvData } = req.body;

    if (!csvData) {
        return res.status(400).json({ error: 'لم يتم إرسال بيانات الملف.' });
    }

    const promptText = `
أنت خبير محاسبي. لديك بيانات ميزان المراجعة التالية بصيغة CSV:

${csvData}

المطلوب:
قم بتحليل البيانات واستخراج القوائم المالية التالية بشكل دقيق جداً، وتقديم النتيجة بصيغة JSON فقط دون أي نصوص إضافية:

{
  "incomeStatement": [
    {"label": "إجمالي الإيرادات والمبيعات", "amount": 0},
    {"label": "إجمالي المصروفات والتكاليف", "amount": 0},
    {"label": "صافي الربح / (الخسارة)", "amount": 0}
  ],
  "balanceSheet": [
    {"label": "إجمالي الأصول", "amount": 0},
    {"label": "إجمالي الالتزامات", "amount": 0},
    {"label": "حقوق الملكية متضمنة أرباح الفترة", "amount": 0},
    {"label": "إجمالي الالتزامات وحقوق الملكية", "amount": 0}
  ],
  "cashFlow": [
    {"label": "صافي الربح التشغيلي", "amount": 0},
    {"label": "النقدية في نهاية الفترة", "amount": 0}
  ],
  "notes": [
    "ملاحظة محاسبية حول جودة البيانات والسيولة",
    "توضيح حول الربحية أو الخسارة"
  ]
}
`;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }]
            })
        });

        const data = await response.json();
        let rawResponse = data.candidates[0].content.parts[0].text;
        
        // تنظيف الاستجابة للوصول للـ JSON فقط
        rawResponse = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResult = JSON.parse(rawResponse);

        return res.status(200).json(jsonResult);

    } catch (error) {
        return res.status(500).json({ error: 'حدث خطأ في الاتصال بنموذج الذكاء الاصطناعي.', details: error.message });
    }
}
