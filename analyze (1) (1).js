// api/analyze.js
//
// ==========================================================================
// ملخص التعديل:
// الهدف الأصلي كان يطلب من Gemini "يخترع" القوائم المالية النهائية بصيغة
// مختلفة تمامًا عن الصيغة التي تستخدمها الواجهة (index.html) في دالة
// computeStatements(). ده كان يعني إن الناتج مش هيطابق "نفس التقرير" اللي
// الواجهة بتنتجه (لا في أسماء الحقول ولا في طريقة الحساب).
//
// التعديل الجديد: خلّينا شغل Gemini يقتصر على "تصنيف" كل حساب إلى نفس
// أكواد التصنيف الثابتة اللي الواجهة بتفهمها (cash, ar, revenue, cogs...).
// أما جمع الأرقام وحساب القوائم (قائمة الدخل / المركز المالي / التدفقات
// النقدية) فبيتم بنفس منطق الواجهة تمامًا — مافيش أي جمع أو طرح بيعمله
// الذكاء الاصطناعي، عشان نضمن تطابق الأرقام 100% مع نفس التقرير.
//
// الـ Endpoint يرجّع: { accounts, tbTotals }
// وده بالظبط الشكل اللي تقدر تمرره لدالة computeStatements(accounts, tbTotals)
// الموجودة في index.html عشان تحصل على نفس القوائم المالية بنفس الشكل.
// ==========================================================================

// ---- أكواد التصنيف الثابتة (نفس CATEGORY_GROUPS في index.html) ----
const VALID_CATEGORIES = [
  // الأصول المتداولة
  'cash', 'ar', 'other_ca', 'inventory', 'prepaid_to_supplier', 'prepaid',
  'related_party', 'refundable_deposit', 'trading_investment',
  // الأصول غير المتداولة
  'ppe', 'accum_dep', 'intangible', 'accum_amort', 'other_nca',
  // الالتزامات المتداولة
  'ap', 'notes_payable', 'deferred_revenue', 'related_party_payable',
  'accrued', 'leave_provision', 'other_cl',
  // الالتزامات غير المتداولة
  'lt_loan', 'deferred_finance', 'eosb', 'other_ncl',
  // حقوق الملكية
  'capital', 'partner_current', 'reserves', 'retained', 'dividends',
  // الإيرادات
  'revenue', 'other_income',
  // المصروفات
  'cogs', 'sga', 'depreciation', 'finance_cost', 'tax', 'other_expense'
];

const CATEGORY_DESCRIPTIONS = `
- cash: نقدية وما يعادلها (صندوق، بنوك، ودائع تحت الطلب)
- ar: مدينون تجاريون / عملاء
- other_ca: حسابات مدينة أخرى (أصل متداول عام)
- inventory: مخزون / بضاعة
- prepaid_to_supplier: دفعات مقدمة لموردين (رصيد مدين لدى المورد)
- prepaid: مصروفات مدفوعة مقدماً
- related_party: مستحق من أطراف ذات صلة (رصيد مدين)
- refundable_deposit: تأمينات مستردة
- trading_investment: استثمارات تداول قصيرة الأجل
- ppe: أصول ثابتة بالتكلفة التاريخية (ممتلكات وآلات ومعدات)
- accum_dep: مجمع الإهلاك/الاستهلاك (يُخصم من ppe)
- intangible: أصول غير ملموسة (شهرة، علامة تجارية، برمجيات)
- accum_amort: مجمع الإطفاء (يُخصم من intangible)
- other_nca: أصول غير متداولة أخرى
- ap: دائنون تجاريون / موردون
- notes_payable: أوراق الدفع
- deferred_revenue: إيرادات مقدمة / غير مكتسبة
- related_party_payable: مستحق إلى أطراف ذات صلة
- accrued: مصروفات مستحقة
- leave_provision: مخصص بدل إجازة
- other_cl: حسابات دائنة أخرى (التزام متداول عام)
- lt_loan: قروض طويلة الأجل
- deferred_finance: تكلفة تمويلية مؤجلة (تُخصم من القرض)
- eosb: مخصص مكافأة نهاية الخدمة
- other_ncl: التزامات غير متداولة أخرى
- capital: رأس المال
- partner_current: حساب الشريك الجاري (حقوق ملكية)
- reserves: احتياطيات
- retained: أرباح مبقاة / خسائر متراكمة (رصيد أول المدة)
- dividends: توزيعات أرباح (تُخصم من حقوق الملكية)
- revenue: إيرادات / مبيعات تشغيلية
- other_income: إيرادات أخرى غير تشغيلية
- cogs: تكلفة المبيعات / تكلفة البضاعة المباعة
- sga: مصاريف بيعية وتسويقية وعمومية وإدارية (رواتب، إيجار، تسويق...)
- depreciation: مصروف إهلاك واستهلاك (وليس المجمع)
- finance_cost: مصاريف تمويلية / فوائد
- tax: ضريبة / زكاة
- other_expense: مصاريف أخرى غير مصنّفة
`.trim();

// ---- تحويل نص CSV بسيط إلى صفوف {name, debit, credit} ----
// يقبل فواصل (,) أو (؛) أو تاب، وأعمدة بأي ترتيب طالما فيها اسم الحساب
// ورقمين (مدين/دائن) على الأقل.
function parseCsvRows(csvData) {
  const lines = String(csvData)
    .split(/\r\n|\n|\r/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (!lines.length) return [];

  function splitLine(line) {
    // يدعم فواصل شائعة، مع دعم بسيط للقيم المحاطة بعلامات اقتباس
    const delimiter = line.includes('\t') ? '\t' : (line.includes(';') ? ';' : ',');
    const parts = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === delimiter && !inQuotes) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur.trim());
    return parts;
  }

  function toNumber(v) {
    if (v == null) return 0;
    const cleaned = String(v).replace(/[^\d.\-]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
  }

  const header = splitLine(lines[0]).map(h => h.toLowerCase());
  const looksLikeHeader = header.some(h =>
    /name|account|حساب|اسم/i.test(h)) && header.some(h => /debit|مدين/i.test(h) || /credit|دائن/i.test(h));

  let nameIdx = 0, debitIdx = 1, creditIdx = 2;
  let startRow = 0;

  if (looksLikeHeader) {
    startRow = 1;
    nameIdx = header.findIndex(h => /name|account|حساب|اسم/i.test(h));
    debitIdx = header.findIndex(h => /debit|مدين/i.test(h));
    creditIdx = header.findIndex(h => /credit|دائن/i.test(h));
    if (nameIdx === -1) nameIdx = 0;
    if (debitIdx === -1) debitIdx = 1;
    if (creditIdx === -1) creditIdx = 2;
  }

  const rows = [];
  for (let i = startRow; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    const name = (cols[nameIdx] || '').trim();
    if (!name) continue;
    rows.push({
      name,
      debit: toNumber(cols[debitIdx]),
      credit: toNumber(cols[creditIdx])
    });
  }
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'مفتاح GEMINI_API_KEY غير معرّف في Vercel Environment Variables.' });
  }

  const { csvData } = req.body || {};
  if (!csvData) {
    return res.status(400).json({ error: 'لم يتم إرسال بيانات الملف.' });
  }

  // 1) نفسّر ميزان المراجعة بأنفسنا (أرقام دقيقة 100%، بدون أي تدخل من الذكاء الاصطناعي)
  const parsedRows = parseCsvRows(csvData);
  if (!parsedRows.length) {
    return res.status(400).json({ error: 'تعذر قراءة أي صفوف من بيانات ميزان المراجعة المرسلة.' });
  }

  // 2) نطلب من Gemini تصنيف كل حساب فقط (بدون أي حسابات أو مجاميع)
  const accountsListForPrompt = parsedRows
    .map((r, i) => `${i}. ${r.name} — مدين: ${r.debit} — دائن: ${r.credit}`)
    .join('\n');

  const promptText = `
أنت خبير محاسبي متخصص في تصنيف حسابات ميزان المراجعة وفق معايير المحاسبة الدولية (IFRS).

لديك القائمة التالية من الحسابات (رقم الصف — اسم الحساب — مدين — دائن):
${accountsListForPrompt}

المطلوب: صنّف كل حساب إلى واحد فقط من الأكواد التالية (استخدم الكود بالضبط كما هو، بحروف إنجليزية صغيرة):
${CATEGORY_DESCRIPTIONS}

قواعد مهمة:
- إذا كان اسم الحساب غامضاً ولا يمكن تصنيفه بثقة ضمن أي كود أعلاه، استخدم قيمة فارغة "" ولا تخترع كوداً غير موجود في القائمة.
- لا تُغيّر ترتيب الحسابات ولا تُدمج أو تحذف أي حساب — يجب أن يكون عدد عناصر "classifications" في الناتج مطابقاً تماماً لعدد الحسابات المُرسلة (${parsedRows.length}).
- لا تحسب أي مجاميع أو أرصدة؛ مهمتك التصنيف فقط.

أعد النتيجة بصيغة JSON فقط دون أي نص إضافي أو Markdown، بهذا الشكل بالضبط:
{
  "classifications": [
    { "index": 0, "name": "اسم الحساب كما ورد", "cat": "الكود المناسب" }
  ]
}
`;

  let classifications = [];
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }]
      })
    });

    const data = await response.json();
    let rawResponse = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!rawResponse) {
      throw new Error('لم يرجع نموذج الذكاء الاصطناعي أي نص.');
    }

    rawResponse = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    const jsonResult = JSON.parse(rawResponse);
    classifications = Array.isArray(jsonResult.classifications) ? jsonResult.classifications : [];
  } catch (error) {
    return res.status(500).json({ error: 'حدث خطأ في الاتصال بنموذج الذكاء الاصطناعي.', details: error.message });
  }

  // 3) نبني مصفوفة classification مطابقة لطول الحسابات الأصلي (بالترتيب أولاً، مع مطابقة بالاسم كخط دفاع ثانٍ)
  const byIndex = new Map();
  const byName = new Map();
  classifications.forEach(c => {
    if (c == null) return;
    if (typeof c.index === 'number') byIndex.set(c.index, c.cat);
    if (typeof c.name === 'string') byName.set(c.name.trim(), c.cat);
  });

  const accounts = parsedRows.map((row, i) => {
    let cat = byIndex.has(i) ? byIndex.get(i) : byName.get(row.name);
    if (typeof cat !== 'string' || !VALID_CATEGORIES.includes(cat)) {
      cat = ''; // غير مصنّف — نفس سلوك الواجهة عند عدم التصنيف (يُظهر تحذيراً للمراجعة اليدوية)
    }
    return {
      name: row.name,
      debit: row.debit,
      credit: row.credit,
      cat
    };
  });

  // 4) نحسب إجماليات ميزان المراجعة بأنفسنا (بدون أي اعتماد على الذكاء الاصطناعي)
  const totalDebit = accounts.reduce((s, a) => s + (Number(a.debit) || 0), 0);
  const totalCredit = accounts.reduce((s, a) => s + (Number(a.credit) || 0), 0);
  const diff = totalDebit - totalCredit;
  const tbTotals = {
    totalDebit,
    totalCredit,
    balanced: Math.abs(diff) < 1,
    diff
  };

  const unclassifiedCount = accounts.filter(a => !a.cat).length;

  // الناتج جاهز ليُمرَّر مباشرة إلى computeStatements(accounts, tbTotals)
  // الموجودة في index.html لإنتاج نفس القوائم المالية بنفس الشكل والحقول تماماً.
  return res.status(200).json({
    accounts,
    tbTotals,
    unclassifiedCount
  });
}

/* ==========================================================================
 * الكود الأصلي (قبل التعديل) — تم الإبقاء عليه كمرجع فقط ولم يتم حذفه بناءً
 * على طلبك. غير مُستخدَم حالياً (الدالة الفعّالة هي الموجودة أعلاه).
 * ==========================================================================

// api/analyze.js  (النسخة القديمة)
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

* ========================================================================== */
