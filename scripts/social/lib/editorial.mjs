// Editorial content — the posts that do NOT promote a specific property.
//
// Why this file is as big as it is: a post that names or shows a specific property needs a
// REGA per-ad advertising licence, and Bona has none yet, so every listing post lands in the
// queue `blocked: true`. Editorial posts carry no such obligation, so these are the posts the
// owner can publish TODAY. There are deliberately a lot of them.
//
// Discipline for everything in here:
//   * No price, no valuation, no forecast, no yield, no "the market will…". TAQEEM reserves
//     valuation to licensed valuers and REGA polices property advertising; an opinion about
//     where prices are going is the fastest way to a complaint.
//   * No rates, fees or percentages. They change, and a stale number in a caption is a lie
//     with a date on it. Point at the authority instead (REGA, Najiz, Ejar, ZATCA, Wafi).
//   * No property is identified: no ref, no price, no specs, no address. A photograph from
//     the portfolio may illustrate a district post; it may not become an advert for the home
//     in it. isEditorial() below is what keeps that honest.
//   * No mention of TK Estates, ever.

/** Photo sourcing hint: which listing's photography may illustrate the card. */
const anyOf = (...districts) => ({ district: districts });

export const EDITORIAL = [
  // ---------------- brand ----------------
  {
    id: 'brand-manifesto', pillar: 'brand', format: 'story-card',
    title: { ar: 'لماذا «بهدوء»', en: 'Why "quietly"' },
    ar: 'لا ننشر كل شيء.\nنمثّل عدداً محدوداً من المنازل، ونعرفها واحداً واحداً.',
    en: 'We do not list everything.\nWe represent a small number of homes, and we know each one.',
    caption: {
      ar: 'بونا بوتيك عقاري في جدة. نمثّل عدداً محدوداً من المنازل في كل حي، ونعرف كل واحد منها عن قرب — الصك، المخططات، الجيران، وقت الشمس على الشرفة.\n\nهذا يعني أننا نقول «لا» كثيراً. ويعني أن ما نعرضه، نقف خلفه.\n\nمنازل استثنائية، بهدوء.',
      en: 'Bona is a boutique in Jeddah. We represent a small number of homes in each district and we know each one closely — the deed, the plans, the neighbours, when the sun reaches the terrace.\n\nThat means saying no, often. It also means we stand behind what we do show.\n\nExceptional homes, quietly.',
    },
    tags: 'brand',
  },
  {
    id: 'brand-how-we-work', pillar: 'brand', format: 'story-card',
    title: { ar: 'كيف نعمل', en: 'How we work' },
    ar: 'موعد واحد.\nثلاثة منازل.\nلا قوائم لا تنتهي.',
    en: 'One appointment.\nThree homes.\nNot an endless list.',
    caption: {
      ar: 'تخبرنا بما تريده. نعود إليك بثلاثة منازل — لا ثلاثين.\n\nنرتّب المعاينات في يوم واحد، ونذهب معك. تسأل، ونجيب بما نعرفه فقط؛ وما لا نعرفه نذهب ونتحقق منه.\n\nواتساب في البايو.',
      en: 'Tell us what you are looking for. We come back with three homes — not thirty.\n\nWe arrange the viewings in one day and we come with you. You ask; we answer with what we actually know, and go and check what we do not.\n\nWhatsApp in bio.',
    },
    tags: 'brand',
  },
  {
    id: 'brand-sell-with-us', pillar: 'brand', format: 'story-card',
    title: { ar: 'بِع مع بونا', en: 'Sell with Bona' },
    ar: 'تسويق بخصوصية\nللمُلّاك',
    en: 'Discreet marketing\nfor owners',
    caption: {
      ar: 'بعض المُلّاك لا يريدون لوحة على السور ولا إعلاناً في كل تطبيق.\n\nنسوّق بهدوء: تصوير محترم، ملف تعريفي واحد، ومشترون منتقون. لا نعرض منزلك على من لم يثبت جديّته.\n\nللبدء نحتاج ثلاثة أشياء: الصك، المخططات، وموعداً للتصوير.\n\nراسلنا على واتساب.',
      en: 'Some owners do not want a board on the wall and an advert in every app.\n\nWe market quietly: careful photography, one dossier, selected buyers. Your home is not shown to anyone who has not shown they are serious.\n\nTo start we need three things: the title deed, the plans, and a date for the shoot.\n\nMessage us on WhatsApp.',
    },
    tags: 'brand',
  },
  {
    id: 'brand-hours', pillar: 'brand', format: 'story-card',
    title: { ar: 'المكتب مفتوح', en: 'The office is open' },
    ar: 'الأحد – الخميس\n10:00 – 19:00',
    en: 'Sunday – Thursday\n10:00 – 19:00',
    caption: {
      ar: 'المكتب مفتوح الأحد إلى الخميس، من 10 صباحاً إلى 7 مساءً. واتساب يعمل خارج هذه الأوقات وسنرد في أول يوم عمل.\n\nجدة — حي الروضة.',
      en: 'Open Sunday to Thursday, 10:00 to 19:00. WhatsApp runs outside those hours and we reply on the next working day.\n\nJeddah — Al Rawdah district.',
    },
    tags: 'brand',
  },
  {
    id: 'brand-national-day', pillar: 'brand', format: 'story-card', seasonal: '09-23',
    title: { ar: 'اليوم الوطني', en: 'Saudi National Day' },
    ar: 'كل عام والوطن بخير',
    en: 'Happy National Day',
    caption: {
      ar: 'كل عام والمملكة بخير.\n\nالمكتب مغلق اليوم. نعود غداً.',
      en: 'Happy National Day.\n\nThe office is closed today. Back tomorrow.',
    },
    extraTags: ['#اليوم_الوطني', '#SaudiNationalDay', '#هي_لنا_دار'],
    tags: 'brand',
  },

  // ---------------- buyer / seller education ----------------
  {
    id: 'edu-ad-licence', pillar: 'education', format: 'story-card',
    title: { ar: 'ترخيص الإعلان العقاري', en: 'The advertising licence' },
    ar: 'كل إعلان عقاري نظامي\nيحمل رقم ترخيص',
    en: 'Every lawful property ad\ncarries a licence number',
    caption: {
      ar: 'في السعودية، الإعلان عن عقار للبيع أو للإيجار يحتاج ترخيص إعلان عقاري صادر عن الهيئة العامة للعقار، ويُذكر رقمه في الإعلان نفسه.\n\nقبل أن تتواصل مع أي إعلان: ابحث عن الرقم. وجوده يعني أن العقار موثّق وأن المعلن معروف للجهة المنظّمة.\n\nنحن وسيط مرخّص — رقم فال في البايو — وكل إعلان عقار لدينا يحمل رقم ترخيصه.',
      en: 'In Saudi Arabia, advertising a property for sale or rent requires an advertising licence from the Real Estate General Authority (REGA), and the licence number must appear in the advert itself.\n\nBefore you contact any listing: look for the number. Its presence means the property is documented and the advertiser is known to the regulator.\n\nWe are a licensed brokerage — FAL number in bio — and every property advert we publish carries its licence number.',
    },
    tags: 'edu',
  },
  {
    id: 'edu-deed-najiz', pillar: 'education', format: 'story-card',
    title: { ar: 'تحقّق من الصك', en: 'Check the deed' },
    ar: 'الصك الإلكتروني\nيُتحقق منه في ناجز',
    en: 'An electronic deed\nis verified in Najiz',
    caption: {
      ar: 'الصك الإلكتروني يمكن التحقق منه عبر منصة ناجز (وزارة العدل) قبل أي مبلغ يُدفع.\n\nما الذي تتأكد منه: اسم المالك، رقم الصك، المساحة، الحدود، ووجود أي رهن أو قيد.\n\nنحن نطلب الصك من المالك قبل أن نعرض المنزل — لا نعرض ما لم نره موثّقاً.',
      en: 'An electronic title deed can be verified on the Najiz platform (Ministry of Justice) before any money moves.\n\nWhat you are confirming: the owner\'s name, the deed number, the area, the boundaries, and whether any mortgage or restriction is registered against it.\n\nWe ask the owner for the deed before we show a home. We do not market what we have not seen documented.',
    },
    tags: 'edu',
  },
  {
    id: 'edu-viewing-checklist', pillar: 'education', format: 'story-card',
    title: { ar: 'قبل أن توقّع', en: 'Before you sign' },
    ar: 'سبعة أشياء\nتُفحص في المعاينة',
    en: 'Seven things\nto check at a viewing',
    caption: {
      ar: 'في المعاينة، انظر إلى ما لا يظهر في الصور:\n\n1. اتجاه الواجهة وأين تقع الشمس بعد العصر\n2. ارتفاع الأسقف ومستوى الضوء الطبيعي في كل غرفة\n3. ضغط الماء، ومكان الخزان والمضخة\n4. التكييف: نوعه وعمره ومن يخدمه\n5. عرض الشارع، ومكان وقوف سيارتين\n6. العزل والرطوبة — افحص أسفل النوافذ والحمامات\n7. الجيران: كم وحدة، وهل البناء مكتمل حولك\n\nنمرّ على هذه القائمة معك في كل معاينة.',
      en: 'At a viewing, look at what photographs do not show:\n\n1. Which way the façade faces, and where the sun sits after 4pm\n2. Ceiling height, and the daylight in every room\n3. Water pressure, and where the tank and pump live\n4. Air conditioning: type, age, who services it\n5. Street width, and where two cars actually park\n6. Insulation and damp — check under windows and in bathrooms\n7. The neighbours: how many units, and whether the block around you is finished\n\nWe walk this list with you at every viewing.',
    },
    tags: 'edu',
  },
  {
    id: 'edu-owner-documents', pillar: 'education', format: 'story-card',
    title: { ar: 'للمُلّاك', en: 'For owners' },
    ar: 'ثلاثة مستندات\nتبدأ بها',
    en: 'Three documents\nto start with',
    caption: {
      ar: 'إذا كنت تفكر في بيع منزلك، ابدأ بجمع ثلاثة أشياء:\n\n• الصك (إلكتروني إن أمكن)\n• المخططات المعتمدة ورخصة البناء\n• قائمة بما جُدّد ومتى — المطبخ، التكييف، المسبح\n\nهذه الثلاثة تختصر أسابيع، وتجعل المشتري الجاد يتعامل معك بجدية.\n\nولا يزال بإمكاننا التسويق بهدوء دون نشر عنوانك.',
      en: 'If you are thinking about selling, start by gathering three things:\n\n• The title deed (electronic where possible)\n• The approved plans and the building permit\n• A list of what has been renewed and when — kitchen, air conditioning, pool\n\nThose three save weeks, and they make a serious buyer treat you seriously.\n\nAnd we can still market quietly, without publishing your address.',
    },
    tags: 'edu',
  },
  {
    id: 'edu-offplan-escrow', pillar: 'education', format: 'story-card',
    title: { ar: 'الشراء على الخارطة', en: 'Buying off-plan' },
    ar: 'على الخارطة؟\nاسأل عن حساب الضمان',
    en: 'Off-plan?\nAsk about the escrow account',
    caption: {
      ar: 'بيع الوحدات على الخارطة في السعودية ينظّمه برنامج «وافي». المشروع المرخّص يكون له حساب ضمان، وتُصرف الدفعات منه بحسب مراحل الإنجاز.\n\nثلاثة أسئلة قبل التوقيع:\n• هل المشروع مرخّص من وافي؟\n• ما رقم حساب الضمان، وإلى أين تذهب دفعتي؟\n• ما تاريخ التسليم المكتوب في العقد، وما الذي يحدث إذا تأخر؟\n\nإجابات مكتوبة، لا شفهية.',
      en: 'Off-plan sales in Saudi Arabia are regulated under the Wafi programme. A licensed project has an escrow account, and payments are released from it against construction milestones.\n\nThree questions before you sign:\n• Is the project licensed under Wafi?\n• What is the escrow account, and where exactly does my payment go?\n• What handover date is written in the contract, and what happens if it slips?\n\nAnswers in writing, not in conversation.',
    },
    tags: 'edu',
  },
  {
    id: 'edu-ejar', pillar: 'education', format: 'story-card',
    title: { ar: 'عقد الإيجار', en: 'The lease' },
    ar: 'العقد يُوثَّق\nفي «إيجار»',
    en: 'A lease is registered\nin Ejar',
    caption: {
      ar: 'عقود الإيجار السكنية تُوثّق عبر شبكة «إيجار». العقد الموثّق يحمي الطرفين: المستأجر والمؤجر، ويجعل أي خلاف قابلاً للفصل فيه نظاماً.\n\nقبل أن تدفع: اطلب العقد الموثّق، لا ورقة.\n\nونحن لا نتسلم مبلغاً نيابة عن مالك دون عقد.',
      en: 'Residential leases in Saudi Arabia are registered through the Ejar network. A registered contract protects both sides, and makes any dispute something a body can actually rule on.\n\nBefore you pay: ask for the registered contract, not a piece of paper.\n\nAnd we do not take money on an owner\'s behalf without one.',
    },
    tags: 'edu',
  },
  {
    id: 'edu-area-vs-plot', pillar: 'education', format: 'story-card',
    title: { ar: 'المساحة', en: 'Area' },
    ar: 'مساحة الأرض\nليست مساحة البناء',
    en: 'Plot area\nis not built area',
    caption: {
      ar: 'رقمان مختلفان يُخلط بينهما كثيراً:\n\n• مساحة الأرض — حدود الصك\n• مساحة البناء — مجموع الأدوار المبنية\n\nفيلا على أرض 400 م² قد يكون بناؤها 600 م² على ثلاثة أدوار. والعكس صحيح: أرض كبيرة ببناء صغير.\n\nعندما تقارن منزلين، قارن الرقم نفسه. نكتب الرقمين في كل عقار لدينا عندما يكونان معروفين — وإذا لم يكن أحدهما معروفاً، لا نخمّنه.',
      en: 'Two different numbers, constantly mixed up:\n\n• Plot area — the boundary on the deed\n• Built area — the sum of the constructed floors\n\nA villa on a 400 m² plot may have 600 m² of building across three floors. The reverse happens too: a large plot with a small house.\n\nWhen you compare two homes, compare the same number. We publish both whenever both are known — and where one is not known, we do not guess it.',
    },
    tags: 'edu',
  },
  {
    id: 'edu-broker-licence', pillar: 'education', format: 'story-card',
    title: { ar: 'الوسيط المرخّص', en: 'A licensed broker' },
    ar: 'اسأل عن رقم فال',
    en: 'Ask for the FAL number',
    caption: {
      ar: '«فال» هو ترخيص مزاولة الوساطة العقارية في السعودية. الوسيط المرخّص له رقم، ويمكن التحقق منه.\n\nما الذي يعنيه لك عملياً: عقد وساطة مكتوب، أتعاب معلومة مسبقاً، ومسؤولية نظامية عمّا يُقال لك.\n\nرقم فال الخاص بنا في البايو وعلى كل إعلان.',
      en: '"FAL" is the licence to practise real-estate brokerage in Saudi Arabia. A licensed broker has a number, and it can be checked.\n\nWhat it means for you in practice: a written brokerage agreement, a fee agreed in advance, and legal responsibility for what you are told.\n\nOur FAL number is in the bio and on every advert.',
    },
    tags: 'edu',
  },

  // ---------------- market insight (facts, never forecasts) ----------------
  {
    id: 'market-no-valuation', pillar: 'market', format: 'story-card',
    title: { ar: 'لماذا لا نقدّر الأسعار', en: 'Why we do not value' },
    ar: 'لا نُقدّر قيمة عقار.\nهذا عمل مقيّم معتمد.',
    en: 'We do not value property.\nThat is an accredited valuer\'s work.',
    caption: {
      ar: 'يسألنا كثيرون: «كم يساوي بيتي؟»\n\nالجواب الأمين: تقدير قيمة العقار عمل يقوم به مقيّم معتمد من الهيئة السعودية للمقيمين المعتمدين (تقييم)، لا وسيط.\n\nما نستطيع قوله: السعر المطلوب المكتوب من المالك، وما بيع فعلاً في الحي إن كان منشوراً رسمياً. وما لا نستطيع: رقماً من عندنا.\n\nولهذا سترى في بعض عقاراتنا «السعر عند الطلب» — لأن المالك لم يكتب رقماً بعد، لا لأننا نخفيه.',
      en: 'We are often asked: "what is my house worth?"\n\nThe honest answer: valuing a property is the work of a valuer accredited by the Saudi Authority for Accredited Valuers (TAQEEM) — not a broker.\n\nWhat we can tell you: the asking price the owner has written, and what has actually transacted in the district where that is officially published. What we cannot: a number of our own.\n\nThat is why some of our listings say "Price on request" — because the owner has not written a figure yet, not because we are hiding one.',
    },
    tags: 'edu',
  },
  {
    id: 'market-waterfront', pillar: 'market', format: 'story-card',
    title: { ar: 'ما معنى «واجهة بحرية»', en: 'What "waterfront" means' },
    ar: 'ثلاثة معانٍ مختلفة\nلكلمة واحدة',
    en: 'One word,\nthree different things',
    caption: {
      ar: 'في جدة، «واجهة بحرية» تُقال عن ثلاثة أشياء مختلفة تماماً:\n\n• على الكورنيش — إطلالة عامة، وصول عام، وحركة\n• على خور أو مرسى — ماء هادئ، غالباً داخل مجمع\n• شاطئ خاص — رمل يخصّ العقار أو المجمع وحده\n\nالفرق بينها ليس في المنظر، بل في الخصوصية، والصيانة، ومن يملك الرمل.\n\nاسأل دائماً: هل الشاطئ ملك، أم حق انتفاع، أم مشترك؟',
      en: 'In Jeddah, "waterfront" is used for three completely different things:\n\n• On the Corniche — a public view, public access, and traffic\n• On a creek or marina — calm water, usually inside a compound\n• A private beach — sand that belongs to the property or its community alone\n\nThe difference is not the view. It is privacy, maintenance, and who owns the sand.\n\nAlways ask: is the beach owned, a right of use, or shared?',
    },
    tags: 'water',
  },
  {
    id: 'market-house-types', pillar: 'market', format: 'story-card',
    title: { ar: 'فيلا، دوبلكس، تاون هاوس', en: 'Villa, duplex, townhouse' },
    ar: 'ثلاثة أسماء\nوثلاثة أشياء مختلفة',
    en: 'Three names,\nthree different things',
    caption: {
      ar: 'تُستخدم هذه الكلمات في جدة بمعانٍ متقاربة، والفرق مهم:\n\n• فيلا — مبنى قائم بذاته على أرضه، بلا جدران مشتركة\n• دوبلكس — نصف مبنى، جدار مشترك واحد، مدخل مستقل\n• تاون هاوس — وحدة ضمن صف، جداران مشتركان غالباً، وأرض أصغر\n\nالسؤال العملي ليس الاسم، بل: كم جداراً مشتركاً؟ ومن يملك ما بينهما؟\n\nنكتب نوع المبنى في كل عقار كما هو في المخططات، لا كما يبدو في الصورة.',
      en: 'These words are used loosely in Jeddah, and the difference matters:\n\n• Villa — a standalone building on its own plot, no shared walls\n• Duplex — half a building, one shared wall, its own entrance\n• Townhouse — one unit in a row, usually two shared walls, a smaller plot\n\nThe practical question is not the name but: how many shared walls, and who owns what is between them?\n\nWe write the building type as the plans state it, not as the photograph suggests.',
    },
    tags: 'edu',
  },
  {
    id: 'market-offmarket', pillar: 'market', format: 'story-card',
    title: { ar: 'خارج السوق', en: 'Off-market' },
    ar: 'ليس كل منزل\nيصل إلى التطبيقات',
    en: 'Not every home\nreaches the apps',
    caption: {
      ar: '«خارج السوق» تعني أن المالك لا يريد إعلاناً عاماً: لا لوحة، ولا صور منتشرة، ولا أسئلة من الجيران.\n\nهذه المنازل موجودة، وتُعرض على من أثبت جدّيته فقط.\n\nإذا كنت تبحث عن شيء محدد جداً في حي محدد، أخبرنا به بدل أن تنتظر ظهوره — أغلب ما يليق لا يُنشر.',
      en: '"Off-market" means the owner does not want a public advert: no board, no photographs circulating, no questions from the neighbours.\n\nThese homes exist, and they are shown only to buyers who have shown they are serious.\n\nIf you are looking for something specific in a specific district, tell us rather than waiting for it to appear. Most of what suits is never published.',
    },
    tags: 'brand',
  },
];

/** Short, safe, non-promotional notes for the districts our portfolio actually sits in. */
export const DISTRICT_NOTES = {
  'durrat al arous': {
    ar: 'مجمع مسوّر شمال جدة على البحر مباشرة، بشواطئ ومرافق خاصة به.',
    en: 'A gated community north of Jeddah, directly on the sea, with its own beaches and facilities.',
  },
  'al khalidiyah': {
    ar: 'حي سكني في شمال وسط جدة، قريب من طريق الملك عبدالعزيز والخدمات.',
    en: 'A residential district in north-central Jeddah, close to King Abdulaziz Road and services.',
  },
  'al shati': {
    ar: 'على الواجهة الشمالية، قريب من الكورنيش وأقرب الأحياء الراقية إلى البحر.',
    en: 'On the northern seafront, close to the Corniche — the established district nearest the water.',
  },
  'al rawdah': {
    ar: 'حي مركزي في جدة، سكني وتجاري في آن، وسهل الوصول من معظم المدينة.',
    en: 'A central Jeddah district, residential and commercial at once, easy to reach from most of the city.',
  },
  'al zahra': {
    ar: 'حي هادئ في شمال جدة، قريب من الكورنيش والمدارس.',
    en: 'A quiet district in north Jeddah, near the Corniche and the schools.',
  },
  'al salamah': {
    ar: 'حي سكني شمالي، شوارع واسعة وقرب من الخدمات اليومية.',
    en: 'A northern residential district — wide streets and everyday services close by.',
  },
  'al nahda': {
    ar: 'حي سكني شمال جدة، شهد بناءً حديثاً كثيراً في السنوات الأخيرة.',
    en: 'A residential district in north Jeddah with a lot of recent construction.',
  },
  'al nuzhah': {
    ar: 'حي سكني في شمال جدة، قريب من طريق الأمير سلطان والخدمات.',
    en: 'A residential district in north Jeddah, near Prince Sultan Road and its services.',
  },
  'al murjan': {
    ar: 'شمال جدة قرب الواجهة البحرية، مزيج من الفلل والمجمعات الحديثة.',
    en: 'North Jeddah near the waterfront — a mix of villas and newer compounds.',
  },
  'al basateen': {
    ar: 'حي شمالي قريب من الشاطئ والمرافق، ذو طابع سكني هادئ.',
    en: 'A northern district close to the shore and its facilities, quiet in character.',
  },
  obhur: {
    ar: 'أبحر الشمالية — الساحل شمال جدة، خِيران ومراسٍ ومجمعات على الماء.',
    en: 'North Obhur — the coast north of Jeddah: creeks, marinas and communities on the water.',
  },
};

export const districtNote = (nameEn) => {
  const key = String(nameEn || '').toLowerCase();
  const hit = Object.entries(DISTRICT_NOTES).find(([k]) => key.includes(k) || k.includes(key));
  return hit ? hit[1] : null;
};

export const byId = (id) => EDITORIAL.find((e) => e.id === id) || null;

/**
 * The guard that keeps an editorial post editorial. Anything that would identify one
 * specific property turns the post into an advert, and an advert needs a REGA licence.
 */
export function isEditorial(entry) {
  return entry.pillar !== 'listings' && !entry.listingId;
}
