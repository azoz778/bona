// Bona curated inventory — source of truth for scripts/curate/build.mjs.
// Facts (sizes, rooms, prices, dates) come only from the TK public API snapshot
// or the corresponding TK property page. Prices are TK asking prices; nothing is estimated.
// images: [galleryIndex, roomKey] — index within the gallery folder (scripts/tk-gallery-data.json order).
// An entry may override the folder with { folder, i, room }.

const SA = { en: 'Saudi Arabia', ar: 'المملكة العربية السعودية' };
const JEDDAH = { en: 'Jeddah', ar: 'جدة' };
const loc = (district, city = JEDDAH, country = SA, countryCode = 'SA') => ({ district, city, country, countryCode });
// Round 2 helpers (Kian Al-Masiah units)
const AL_NAHDA = { en: 'Al Nahda', ar: 'النهضة' };
const AL_NUZHAH = { en: 'Al Nuzhah', ar: 'النزهة' };
const AL_RAYYAN = { en: 'Al Rayyan', ar: 'الريان' };
const KIAN = { en: 'Kian Al-Masiah', ar: 'كيان الماسية' };
const KAYAN_PROJECT = { name: { en: 'Kayan Residence, Al Nahda', ar: 'كيان ريزيدنس، النهضة' }, developer: KIAN }; // name === title of kayan-residence-al-nahda
const kianBuilding = (n, district) => ({ name: { en: `Kian Al-Masiah — Building ${n}, ${district.en}`, ar: `كيان الماسية — مبنى ${n}، ${district.ar}` }, developer: KIAN });

export const LISTINGS = [
  // ───────────────────────────── BUY ─────────────────────────────
  {
    slug: 'private-beach-villa-durrat-al-arous', sourceRef: 'VIL-013', status: 'available', category: 'buy', type: 'villa', featured: true,
    title: { en: 'Private Beach Villa, Durrat Al Arous', ar: 'فيلا بشاطئ خاص، درة العروس' },
    location: loc({ en: 'Durrat Al Arous', ar: 'درة العروس' }),
    price: { amount: 8000000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 8, areaSqm: 537, plotSqm: 537, yearBuilt: null, floors: 3 },
    folder: 'private-beach-villa-durrat-al-arous-jeddah',
    images: [[23, 'facade_night'], [13, 'pool'], [14, 'beach'], [12, 'exterior'], [6, 'sea'], [0, 'terrace'], [19, 'living'], [5, 'staircase'], [8, 'living'], [25, 'pool_night']],
    description: {
      en: [
        'Set directly on the shore at Durrat Al Arous, north of Jeddah, this five-bedroom villa opens onto its own stretch of beach and a private pool that looks straight out to sea. Full-height glazing carries the horizon through the ground floor, where the living room, dining area and kitchen face the water.',
        'Four master bedrooms and a kitchenette occupy the first floor. The roof level holds a fifth master bedroom with panoramic views of the beach, together with the maid\'s room and laundry. A private elevator serves every floor, and the house is fully air-conditioned.',
        'The plot measures 537 square metres, with finishes of a high standard throughout. It is a quiet, coastal address a short drive from the city.',
      ],
      ar: [
        'على الشاطئ مباشرة في درة العروس شمال جدة، تنفتح هذه الفيلا ذات الغرف الخمس على شاطئها الخاص ومسبحٍ يطل على البحر مباشرة. تمتد الواجهات الزجاجية على كامل ارتفاع الطابق الأرضي، حيث تطل غرفة المعيشة ومنطقة الطعام والمطبخ على الماء.',
        'يضم الطابق الأول أربع غرف نوم رئيسية ومطبخاً صغيراً. وفي الطابق العلوي غرفة نوم رئيسية خامسة بإطلالة بانورامية على الشاطئ، إلى جانب غرفة الخادمة وغرفة الغسيل. يخدم مصعد خاص جميع الطوابق، والتكييف مركزي في كامل المنزل.',
        'تبلغ مساحة الأرض 537 متراً مربعاً، والتشطيبات على مستوى رفيع في كل التفاصيل. عنوان ساحلي هادئ على مسافة قصيرة بالسيارة من المدينة.',
      ],
    },
    highlights: {
      en: ['Direct beach access', 'Private pool facing the sea', 'Five master bedrooms', 'Private elevator', 'Panoramic sea views from every level', '537 sqm plot'],
      ar: ['وصول مباشر إلى الشاطئ', 'مسبح خاص يطل على البحر', 'خمس غرف نوم رئيسية', 'مصعد خاص', 'إطلالات بحرية بانورامية من كل الطوابق', 'أرض بمساحة 537 متراً مربعاً'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'classic-mansion-al-shati-6', sourceRef: 'VIL-022', status: 'available', category: 'buy', type: 'mansion', featured: true,
    title: { en: 'Classic Mansion, Al Shati 6', ar: 'قصر كلاسيكي، الشاطئ 6' },
    location: loc({ en: 'Al Shati 6', ar: 'الشاطئ 6' }),
    price: { amount: 18000000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 4, baths: 8, areaSqm: 2300, plotSqm: 2227.5, yearBuilt: null, floors: 2 },
    folder: 'exclusive-classic-mansion-al-shati-6',
    images: [[27, 'pool'], [38, 'exterior'], [18, 'hall'], [36, 'living'], [32, 'majlis'], [29, 'dining'], [33, 'kitchen'], [11, 'master'], [26, 'bathroom'], [28, 'pool']],
    description: {
      en: [
        'A classic mansion on a plot of 2,227.5 square metres in Al Shati 6, one of the most established addresses on Jeddah\'s northern waterfront. The house is arranged around a garden with a swimming pool, jacuzzi and cascading water features, with a three-car garage and a rear terrace for outdoor seating.',
        'The ground floor holds four reception rooms, a formal dining room, a large kitchen and a master bedroom with its own sitting room and kitchenette, reached from a side entrance. Upstairs, three further master bedrooms share a living room and a balcony overlooking the pool. Eight bathrooms in total.',
        'Jeddah Yacht Club is a four-minute drive; Red Sea Mall and the Shangri-La are within seven. King Road is immediately accessible.',
      ],
      ar: [
        'قصر كلاسيكي على أرض بمساحة 2,227.5 متر مربع في حي الشاطئ 6، أحد أعرق العناوين على الواجهة البحرية الشمالية لجدة. يلتف المنزل حول حديقة تضم مسبحاً وجاكوزي وشلالات مائية، مع مرآب لثلاث سيارات وتراس خلفي للجلسات الخارجية.',
        'يضم الطابق الأرضي أربع صالات استقبال وغرفة طعام رسمية ومطبخاً كبيراً وغرفة نوم رئيسية بصالة جلوس خاصة ومطبخ صغير، يُصل إليها من مدخل جانبي. وفي الطابق الأول ثلاث غرف نوم رئيسية أخرى تتشارك صالة معيشة وشرفة تطل على المسبح. ثماني دورات مياه في المجموع.',
        'نادي جدة لليخوت على بعد أربع دقائق بالسيارة، ورد سي مول وفندق شانغريلا في حدود سبع دقائق، مع وصول مباشر إلى طريق الملك.',
      ],
    },
    highlights: {
      en: ['2,227.5 sqm plot', 'Pool with jacuzzi and waterfalls', 'Four master bedrooms, eight bathrooms', 'Four reception rooms', 'Three-car garage', 'Four minutes to Jeddah Yacht Club'],
      ar: ['أرض بمساحة 2,227.5 متر مربع', 'مسبح مع جاكوزي وشلالات', 'أربع غرف نوم رئيسية وثماني دورات مياه', 'أربع صالات استقبال', 'مرآب لثلاث سيارات', 'أربع دقائق إلى نادي جدة لليخوت'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'andalus-mansion-jeddah', sourceRef: null, status: 'available', category: 'buy', type: 'mansion', featured: false,
    title: { en: 'Andalus Mansion, Jeddah', ar: 'قصر الأندلس، جدة' },
    location: loc({ en: 'Al Andalus', ar: 'الأندلس' }),
    price: { amount: 12000000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 8, areaSqm: 750, plotSqm: 2500, yearBuilt: null, floors: null },
    folder: 'majestic-andalus-mansion',
    images: [[6, 'pool'], [7, 'pool'], [8, 'exterior'], [1, 'entrance'], [9, 'courtyard'], [2, 'living'], [3, 'majlis'], [5, 'living'], [4, 'dining']],
    description: {
      en: [
        'A mansion on a 2,500-square-metre corner plot in Al Andalus, with frontage on two roads and three separate entrances. The residence is built around a swimming pool and gardens to the front and rear, with a large upper terrace and marble flooring throughout.',
        'Inside are two guest majlis, a salon, a formal dining hall, a living room overlooking the pool, five master bedrooms and a fully fitted kitchen. The built-up area is 750 square metres. Covered parking accommodates up to seven cars, and separate buildings house drivers and staff.',
        'Central air conditioning and double-glazed, thermally insulated windows are fitted throughout.',
      ],
      ar: [
        'قصر على أرض زاوية بمساحة 2,500 متر مربع في حي الأندلس، بواجهتين على شارعين وثلاثة مداخل مستقلة. يلتف المسكن حول مسبح وحدائق أمامية وخلفية، مع تراس علوي واسع وأرضيات رخامية في كل الأرجاء.',
        'في الداخل مجلسان للضيوف وصالون وقاعة طعام رسمية وغرفة معيشة تطل على المسبح وخمس غرف نوم رئيسية ومطبخ مجهز بالكامل. تبلغ مساحة البناء 750 متراً مربعاً. تتسع المواقف المغطاة لسبع سيارات، ويخصص مبنيان مستقلان للسائقين والعاملين.',
        'التكييف مركزي، والنوافذ مزدوجة الزجاج معزولة حرارياً في كامل القصر.',
      ],
    },
    highlights: {
      en: ['2,500 sqm corner plot on two roads', 'Five master suites', 'Pool with front and rear gardens', 'Marble flooring throughout', 'Covered parking for seven cars', 'Separate staff and driver quarters'],
      ar: ['أرض زاوية بمساحة 2,500 متر مربع على شارعين', 'خمسة أجنحة رئيسية', 'مسبح مع حدائق أمامية وخلفية', 'أرضيات رخامية في كل الأرجاء', 'مواقف مغطاة لسبع سيارات', 'ملحقات مستقلة للعاملين والسائقين'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'private-villa-al-murjan', sourceRef: null, status: 'available', category: 'buy', type: 'villa', featured: true,
    title: { en: 'Private Villa, Al Murjan', ar: 'فيلا خاصة، المرجان' },
    location: loc({ en: 'Al Murjan', ar: 'المرجان' }),
    price: { amount: 8499000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 8, areaSqm: 900, plotSqm: 550, yearBuilt: null, floors: 3 },
    folder: 'al-morjan-jeddah',
    images: [[2, 'facade_night'], [6, 'exterior'], [16, 'pool'], [8, 'entrance'], [4, 'living'], [12, 'staircase'], [11, 'living'], [9, 'living']],
    description: {
      en: [
        'A private residence in Al Murjan, moments from King Road and the Corniche. The villa offers 900 square metres of built space on a 550-square-metre plot, arranged over two floors and an independent roof-level annex, with a private pool, a landscaped garden and two internal courtyards that bring light into the centre of the house.',
        'The ground floor is an open-plan living and dining space with a main kitchen and a separate service kitchen. On the first floor, a master bedroom with walk-in closet and balcony is joined by three further en-suite bedrooms, a kitchenette and a small living area. The roof level holds a fifth master suite with dressing room, bathroom and a large terrace, plus the maid\'s room and laundry.',
        'The house is fully integrated with a smart-home system, has an elevator, central air conditioning and parking for two to four cars.',
      ],
      ar: [
        'مسكن خاص في حي المرجان، على مقربة من طريق الملك والكورنيش. توفر الفيلا 900 متر مربع من المساحة المبنية على أرض بمساحة 550 متراً مربعاً، موزعة على طابقين وملحق علوي مستقل، مع مسبح خاص وحديقة منسقة وفناءين داخليين يدخلان الضوء إلى قلب المنزل.',
        'الطابق الأرضي مساحة معيشة وطعام مفتوحة مع مطبخ رئيسي ومطبخ خدمة منفصل. وفي الطابق الأول جناح رئيسي بغرفة ملابس وشرفة، وثلاث غرف نوم أخرى بحمامات خاصة، ومطبخ صغير ومنطقة جلوس. يضم الملحق العلوي جناحاً رئيسياً خامساً بغرفة ملابس وحمام وتراس واسع، إلى جانب غرفة الخادمة وغرفة الغسيل.',
        'المنزل مزود بنظام منزل ذكي متكامل ومصعد وتكييف مركزي ومواقف تتسع لسيارتين إلى أربع سيارات.',
      ],
    },
    highlights: {
      en: ['900 sqm built on a 550 sqm plot', 'Five master suites', 'Private pool and landscaped garden', 'Two internal courtyards', 'Smart-home system and elevator', 'Moments from King Road and the Corniche'],
      ar: ['900 متر مربع مبنية على أرض 550 متراً مربعاً', 'خمسة أجنحة رئيسية', 'مسبح خاص وحديقة منسقة', 'فناءان داخليان', 'نظام منزل ذكي ومصعد', 'على مقربة من طريق الملك والكورنيش'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'contemporary-villa-al-khalidiyah', sourceRef: 'VIL-038', status: 'available', category: 'buy', type: 'villa', featured: true,
    title: { en: 'Contemporary Villa, Al Khalidiyah', ar: 'فيلا عصرية، الخالدية' },
    location: loc({ en: 'Al Khalidiyah', ar: 'الخالدية' }),
    price: { amount: 6700000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 8, areaSqm: 640, plotSqm: 375, yearBuilt: null, floors: 3 },
    folder: 'ultra-modern-luxury-villa-al-khalidiyah',
    images: [[16, 'facade_night'], [25, 'pool_night'], [8, 'pool'], [2, 'entrance'], [74, 'hall'], [78, 'living'], [82, 'kitchen'], [96, 'staircase'], [45, 'bathroom'], [88, 'terrace']],
    description: {
      en: [
        'A newly built contemporary villa in Al Khalidiyah, a few steps from Sari Street and Prince Sultan Road. Behind a restrained façade, the house is organised around a private pool with tiered water features and an outdoor seating area, visible from the two open-plan lounges and the fully fitted kitchen on the ground floor.',
        'A glass elevator with views into the interior links all levels. The first floor holds four master bedrooms, a family sitting room overlooking the pool and a dedicated office. On the roof, a fifth master bedroom opens onto a wide balcony, alongside a lounge and an independent maid\'s room.',
        'Built-up area is 640 square metres on a 375-square-metre plot. A separate service kitchen sits behind the main kitchen.',
      ],
      ar: [
        'فيلا عصرية حديثة البناء في حي الخالدية، على خطوات من شارع صاري وطريق الأمير سلطان. خلف واجهة هادئة، ينتظم المنزل حول مسبح خاص بشلالات متدرجة ومنطقة جلوس خارجية، تظهر من الصالتين المفتوحتين والمطبخ المجهز بالكامل في الطابق الأرضي.',
        'يربط مصعد زجاجي بإطلالة داخلية جميع الطوابق. يضم الطابق الأول أربع غرف نوم رئيسية وصالة عائلية تطل على المسبح ومكتباً مستقلاً. وفي السطح غرفة نوم رئيسية خامسة تنفتح على شرفة واسعة، إلى جانب صالة وغرفة خادمة مستقلة.',
        'مساحة البناء 640 متراً مربعاً على أرض بمساحة 375 متراً مربعاً، مع مطبخ خدمة منفصل خلف المطبخ الرئيسي.',
      ],
    },
    highlights: {
      en: ['Steps from Sari Street and Prince Sultan Road', 'Private pool with water features', 'Glass elevator to all floors', 'Five master bedrooms and a dedicated office', '640 sqm built-up area', 'Separate service kitchen'],
      ar: ['على خطوات من شارع صاري وطريق الأمير سلطان', 'مسبح خاص بشلالات', 'مصعد زجاجي لجميع الطوابق', 'خمس غرف نوم رئيسية ومكتب مستقل', 'مساحة بناء 640 متراً مربعاً', 'مطبخ خدمة منفصل'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'modern-villa-al-zahra', sourceRef: null, status: 'available', category: 'buy', type: 'villa', featured: true,
    title: { en: 'Modern Villa, Al Zahra', ar: 'فيلا حديثة، الزهراء' },
    location: loc({ en: 'Al Zahra', ar: 'الزهراء' }),
    price: { amount: 7400000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 3, baths: 8, areaSqm: 850, plotSqm: 375, yearBuilt: null, floors: 4 },
    folder: 'modren-villa-al-zahra',
    images: [[27, 'pool'], [34, 'exterior'], [0, 'pool'], [5, 'entrance'], [38, 'living'], [11, 'kitchen'], [12, 'dining'], [36, 'staircase'], [23, 'bathroom'], [26, 'terrace']],
    description: {
      en: [
        'A modern villa in Al Zahra, positioned behind Stars Avenue and a few steps from King Road, Sari Street and Prince Sultan Road. The house spans 850 square metres of built area on a 375-square-metre plot, over three floors and a basement, with an outdoor pool and waterfall and an elevator connecting every level.',
        'The basement is given over to a large living room, a fully fitted kitchen with an island, storage and direct access to the pool. Two living rooms overlook the pool on the ground floor, with a guest bathroom. The next floor holds three master bedrooms, each with an en-suite bathroom, and a small kitchen; the top floor has a living room opening onto a large garden terrace, the maid\'s room and a separate laundry.',
        'Eight bathrooms in total, with high-specification fittings throughout.',
      ],
      ar: [
        'فيلا حديثة في حي الزهراء، خلف ستارز أفينيو وعلى خطوات من طريق الملك وشارع صاري وطريق الأمير سلطان. تمتد على 850 متراً مربعاً من المساحة المبنية على أرض بمساحة 375 متراً مربعاً، عبر ثلاثة طوابق وقبو، مع مسبح خارجي بشلال ومصعد يربط جميع المستويات.',
        'خُصص القبو لغرفة معيشة كبيرة ومطبخ مجهز بالكامل بجزيرة وسطية ومستودع ووصول مباشر إلى المسبح. وفي الطابق الأرضي صالتان تطلان على المسبح مع حمام للضيوف. يضم الطابق التالي ثلاث غرف نوم رئيسية بحمامات خاصة ومطبخاً صغيراً، أما الطابق الأخير فيضم صالة تنفتح على تراس حديقة واسع وغرفة الخادمة وغرفة غسيل مستقلة.',
        'ثماني دورات مياه في المجموع، بتجهيزات عالية المواصفات في كل الأرجاء.',
      ],
    },
    highlights: {
      en: ['850 sqm built-up over three floors and a basement', 'Pool with waterfall', 'Three master suites, eight bathrooms', 'Elevator to all floors', 'Large garden terrace', 'Behind Stars Avenue, steps from King Road'],
      ar: ['850 متراً مربعاً مبنية على ثلاثة طوابق وقبو', 'مسبح بشلال', 'ثلاثة أجنحة رئيسية وثماني دورات مياه', 'مصعد لجميع الطوابق', 'تراس حديقة واسع', 'خلف ستارز أفينيو وعلى خطوات من طريق الملك'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'rooftop-view-villa-al-mohammadiyah', sourceRef: null, status: 'available', category: 'buy', type: 'villa', featured: false,
    title: { en: 'Rooftop-View Villa, Al Mohammadiyah', ar: 'فيلا بإطلالة علوية، المحمدية' },
    location: loc({ en: 'Al Mohammadiyah', ar: 'المحمدية' }),
    price: { amount: 5499000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 4, baths: 7, areaSqm: 600, plotSqm: 407, yearBuilt: null, floors: 3 },
    folder: 'luxury-modren-villa-al-mohamadyah-jeddah',
    images: [[8, 'pool'], [46, 'pool_night'], [6, 'exterior'], [21, 'living'], [38, 'view'], [17, 'living'], [22, 'staircase'], [35, 'bathroom'], [42, 'terrace'], [43, 'skyline']],
    description: {
      en: [
        'A modern villa in Al Mohammadiyah with direct access to King Road and Prince Sultan Road. The house offers 600 square metres of built space on a 407-square-metre plot, with a private pool, a small garden, a one-car garage, an elevator, ducted air conditioning and smart-home controls.',
        'Two living rooms on the ground floor look onto the pool, alongside the kitchen, two guest bathrooms and a maid\'s room with en-suite. Three master bedrooms with pool views, a laundry and a kitchenette occupy the first floor. The second floor holds a living room with kitchenette and opens onto a roof terrace with a wide view over the Jeddah skyline and the towers along King Road.',
      ],
      ar: [
        'فيلا حديثة في حي المحمدية بوصول مباشر إلى طريق الملك وطريق الأمير سلطان. يوفر المنزل 600 متر مربع من المساحة المبنية على أرض بمساحة 407 أمتار مربعة، مع مسبح خاص وحديقة صغيرة ومرآب لسيارة ومصعد وتكييف مخفي ونظام منزل ذكي.',
        'تطل صالتان في الطابق الأرضي على المسبح، إلى جانب المطبخ وحمامين للضيوف وغرفة خادمة بحمام خاص. ويضم الطابق الأول ثلاث غرف نوم رئيسية بإطلالة على المسبح وغرفة غسيل ومطبخاً صغيراً. أما الطابق الثاني فيضم صالة بمطبخ صغير وينفتح على تراس علوي بإطلالة واسعة على أفق جدة والأبراج الممتدة على طريق الملك.',
      ],
    },
    highlights: {
      en: ['Roof terrace with skyline views', 'Four master suites, seven bathrooms', 'Private pool and garden', 'Elevator and smart-home system', '600 sqm built-up area', 'Direct access to King Road and Prince Sultan Road'],
      ar: ['تراس علوي بإطلالة على أفق المدينة', 'أربعة أجنحة رئيسية وسبع دورات مياه', 'مسبح خاص وحديقة', 'مصعد ونظام منزل ذكي', 'مساحة بناء 600 متر مربع', 'وصول مباشر إلى طريق الملك وطريق الأمير سلطان'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'timber-villa-al-mohammadiyah', sourceRef: null, status: 'available', category: 'buy', type: 'villa', featured: false,
    title: { en: 'Timber-Detailed Villa, Al Mohammadiyah', ar: 'فيلا بتفاصيل خشبية، المحمدية' },
    location: loc({ en: 'Al Mohammadiyah', ar: 'المحمدية' }),
    price: { amount: 5000000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 8, areaSqm: null, plotSqm: 402, yearBuilt: null, floors: 3 },
    folder: 'modren-villa-al-mohammadiyyah',
    images: [[34, 'facade_night'], [45, 'exterior'], [32, 'pool_night'], [12, 'entrance'], [26, 'living'], [13, 'gallery'], [29, 'kitchen'], [17, 'master'], [21, 'bathroom'], [39, 'staircase']],
    description: {
      en: [
        'A villa in Al Mohammadiyah, close to King Road and Prince Sultan Road, finished in a warm palette of timber-clad walls, parquet flooring and marble. The house sits on a 402-square-metre plot with a swimming pool that connects directly to the living area, a garden seating area and a one-car garage.',
        'The ground floor holds two living rooms, an American-style kitchen with a concealed back kitchen, a laundry, a maid\'s room and two bathrooms. Three master bedrooms with wooden floors and marble bathrooms occupy the first floor, with a small sitting area. Two further bedrooms, a bathroom and a large terrace overlooking King Road complete the top floor.',
        'Smart-home controls run from dedicated tablets or a phone, and a glass elevator links the floors.',
      ],
      ar: [
        'فيلا في حي المحمدية، قريبة من طريق الملك وطريق الأمير سلطان، بتشطيبات دافئة من الجدران المكسوة بالخشب وأرضيات الباركيه واللمسات الرخامية. تقع على أرض بمساحة 402 متر مربع مع مسبح يتصل مباشرة بمنطقة المعيشة ومنطقة جلوس في الحديقة ومرآب لسيارة.',
        'يضم الطابق الأرضي صالتين ومطبخاً أمريكياً بمطبخ خلفي مخفي وغرفة غسيل وغرفة خادمة وحمامين. وفي الطابق الأول ثلاث غرف نوم رئيسية بأرضيات خشبية وحمامات رخامية ومنطقة جلوس صغيرة. ويكتمل الطابق الأخير بغرفتي نوم وحمام وتراس واسع يطل على طريق الملك.',
        'يُدار نظام المنزل الذكي من أجهزة لوحية مخصصة أو من الهاتف، ويربط مصعد زجاجي بين الطوابق.',
      ],
    },
    highlights: {
      en: ['Timber, parquet and marble finishes', 'Pool connected to the living area', 'Five bedrooms, eight bathrooms', 'Glass elevator', 'Smart-home control by tablet or phone', 'Terrace overlooking King Road'],
      ar: ['تشطيبات من الخشب والباركيه والرخام', 'مسبح متصل بمنطقة المعيشة', 'خمس غرف نوم وثماني دورات مياه', 'مصعد زجاجي', 'تحكم ذكي من الجهاز اللوحي أو الهاتف', 'تراس يطل على طريق الملك'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'garden-facing-villa-al-sheraa-north-obhur', sourceRef: null, status: 'available', category: 'buy', type: 'villa', featured: true,
    title: { en: 'Garden-Facing Villa, Al Shera\'a, North Obhur', ar: 'فيلا مطلة على حديقة، الشراع، أبحر الشمالية' },
    location: loc({ en: 'Al Shera\'a, North Obhur', ar: 'الشراع، أبحر الشمالية' }),
    price: { amount: 3800000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 8, areaSqm: 1200, plotSqm: 450, yearBuilt: null, floors: 3 },
    folder: 'modren-villa-al-shera-a-north-obhur',
    images: [[38, 'pool'], [39, 'facade_night'], [2, 'exterior'], [1, 'entrance'], [9, 'staircase'], [5, 'living'], [41, 'courtyard'], [11, 'living'], [23, 'bathroom'], [47, 'pool_night']],
    description: {
      en: [
        'A south-facing villa in the Al Shera\'a scheme of North Obhur, overlooking a large public garden and close to daily services. The house offers 1,200 square metres of built space on a 450-square-metre plot, with ceilings up to 4.3 metres, marble floors, a marble staircase with glass balustrades and a large private pool with waterfalls.',
        'The ground floor holds a private majlis, a living room and a dining room facing the pool, open and closed kitchens, two bathrooms and an independent driver\'s room. On the first floor, a master suite with its own sitting area and dressing room is joined by a second master bedroom with balcony, two further bedrooms and a living room. The second floor has a master bedroom, a living room with office, a large outdoor terrace, a maid\'s room and a laundry.',
        'An elevator, smart-home system and central air conditioning are installed, with manufacturer warranties on the air conditioning, elevator, doors and smart-home system.',
      ],
      ar: [
        'فيلا بواجهة جنوبية في مخطط الشراع بأبحر الشمالية، تطل على حديقة عامة واسعة وقريبة من الخدمات اليومية. يوفر المنزل 1,200 متر مربع من المساحة المبنية على أرض بمساحة 450 متراً مربعاً، بأسقف يصل ارتفاعها إلى 4.3 أمتار وأرضيات رخامية ودرج رخامي بدرابزين زجاجي ومسبح خاص كبير بشلالات.',
        'يضم الطابق الأرضي مجلساً خاصاً وغرفة معيشة وغرفة طعام تطلان على المسبح ومطبخين مفتوحاً ومغلقاً وحمامين وغرفة سائق مستقلة. وفي الطابق الأول جناح رئيسي بمنطقة جلوس وغرفة ملابس، وغرفة نوم رئيسية ثانية بشرفة، وغرفتا نوم إضافيتان وصالة. أما الطابق الثاني فيضم غرفة نوم رئيسية وصالة بمكتب وتراساً خارجياً واسعاً وغرفة خادمة وغرفة غسيل.',
        'المنزل مزود بمصعد ونظام منزل ذكي وتكييف مركزي، مع ضمانات من الشركات المصنعة على التكييف والمصعد والأبواب ونظام المنزل الذكي.',
      ],
    },
    highlights: {
      en: ['1,200 sqm built-up area', 'Ceilings up to 4.3 metres', 'Large pool with waterfalls', 'Five bedrooms, eight bathrooms', 'Elevator and smart-home system', 'Overlooks a large public garden'],
      ar: ['مساحة بناء 1,200 متر مربع', 'أسقف بارتفاع يصل إلى 4.3 أمتار', 'مسبح كبير بشلالات', 'خمس غرف نوم وثماني دورات مياه', 'مصعد ونظام منزل ذكي', 'إطلالة على حديقة عامة واسعة'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'modern-villa-south-obhur', sourceRef: null, status: 'available', category: 'buy', type: 'villa', featured: false,
    title: { en: 'Modern Villa, South Obhur', ar: 'فيلا حديثة، أبحر الجنوبية' },
    location: loc({ en: 'South Obhur', ar: 'أبحر الجنوبية' }),
    price: { amount: 3600000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 8, areaSqm: 620, plotSqm: 375, yearBuilt: null, floors: 3 },
    folder: 'modren-duplex',
    images: [[3, 'facade_night'], [13, 'exterior'], [2, 'entrance'], [9, 'living'], [7, 'staircase'], [6, 'living'], [11, 'courtyard'], [4, 'bathroom']],
    description: {
      en: [
        'A modern villa within the Marafi development in South Obhur, minutes from the Corniche and the main roads. The 375-square-metre plot fronts a 25-metre-wide street, and the house offers roughly 620 square metres of built space with full Italian marble flooring, an Italian elevator and separate ducted air-conditioning units.',
        'The ground floor opens to a majlis, dining room and open kitchen, all facing the garden, with two bathrooms. The first floor holds a master bedroom with dressing room, two further en-suite bedrooms with balconies, a lounge and a study. Two more en-suite bedrooms, a lounge, a maid\'s room, a laundry and front and rear terraces complete the second floor.',
      ],
      ar: [
        'فيلا حديثة ضمن مشروع مرافي في أبحر الجنوبية، على دقائق من الكورنيش والطرق الرئيسية. تطل الأرض البالغة 375 متراً مربعاً على شارع بعرض 25 متراً، ويوفر المنزل نحو 620 متراً مربعاً من المساحة المبنية بأرضيات رخام إيطالي كاملة ومصعد إيطالي ووحدات تكييف مخفي مستقلة.',
        'ينفتح الطابق الأرضي على مجلس وغرفة طعام ومطبخ مفتوح تطل جميعها على الحديقة، مع حمامين. ويضم الطابق الأول غرفة نوم رئيسية بغرفة ملابس وغرفتي نوم بحمامات وشرفات وصالة ومكتباً. وتكتمل الفيلا في الطابق الثاني بغرفتي نوم بحمامات خاصة وصالة وغرفة خادمة وغرفة غسيل وتراسين أمامي وخلفي.',
      ],
    },
    highlights: {
      en: ['Within the Marafi development', 'Full Italian marble flooring', 'Italian elevator', 'Five master bedrooms, eight bathrooms', '25-metre street frontage', 'Minutes from the Corniche'],
      ar: ['ضمن مشروع مرافي', 'أرضيات رخام إيطالي كاملة', 'مصعد إيطالي', 'خمس غرف نوم رئيسية وثماني دورات مياه', 'واجهة على شارع بعرض 25 متراً', 'على دقائق من الكورنيش'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'villa-near-the-corniche-al-lulu-obhur', sourceRef: null, status: 'available', category: 'buy', type: 'villa', featured: false,
    title: { en: 'Villa near the Corniche, Al Lulu, Obhur', ar: 'فيلا قرب الكورنيش، اللؤلؤ، أبحر' },
    location: loc({ en: 'Al Lulu, North Obhur', ar: 'اللؤلؤ، أبحر الشمالية' }),
    price: { amount: 2900000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 7, areaSqm: 550, plotSqm: 383, yearBuilt: null, floors: 3 },
    folder: 'modren-villa-north-obhur',
    images: [[39, 'exterior'], [51, 'facade_night'], [4, 'pool'], [11, 'entrance'], [7, 'living'], [8, 'staircase'], [25, 'view'], [23, 'bathroom'], [34, 'terrace']],
    description: {
      en: [
        'A villa in the Al Lulu district of Obhur, a short walk from the Corniche and the Red Sea shore. The house offers 550 square metres of built space on a 383-square-metre plot, with marble floors, a marble staircase with glass balustrades, ceilings of around three metres, an elevator and parking for two cars.',
        'Two seating areas with direct access to the pool, a living room, a dining room facing the pool, a kitchen, two bathrooms and a garden make up the ground floor. Two master suites with dressing rooms, two further bedrooms, a shared bathroom and an upper living room occupy the first floor. The second floor has a living room, a guest bedroom, the maid\'s quarters, a laundry and a rooftop terrace with views towards the sea.',
        'The pool is fitted with waterfalls, and the house is sold with a schedule of warranties covering the elevator, insulation, structure and air conditioning.',
      ],
      ar: [
        'فيلا في حي اللؤلؤ بأبحر، على مسافة قصيرة سيراً من الكورنيش وشاطئ البحر الأحمر. يوفر المنزل 550 متراً مربعاً من المساحة المبنية على أرض بمساحة 383 متراً مربعاً، بأرضيات رخامية ودرج رخامي بدرابزين زجاجي وأسقف بارتفاع نحو ثلاثة أمتار ومصعد ومواقف لسيارتين.',
        'يتكون الطابق الأرضي من جلستين بوصول مباشر إلى المسبح وغرفة معيشة وغرفة طعام تطل على المسبح ومطبخ وحمامين وحديقة. ويضم الطابق الأول جناحين رئيسيين بغرف ملابس وغرفتي نوم إضافيتين وحماماً مشتركاً وصالة علوية. أما الطابق الثاني فيضم صالة وغرفة نوم للضيوف وجناح الخادمة وغرفة غسيل وتراساً علوياً بإطلالة نحو البحر.',
        'المسبح مزود بشلالات، ويُباع المنزل مع جدول ضمانات يغطي المصعد والعزل والهيكل الإنشائي والتكييف.',
      ],
    },
    highlights: {
      en: ['Short walk to the Corniche', 'Rooftop terrace with sea views', 'Pool with waterfalls', 'Two master suites with dressing rooms', 'Elevator and smart-home features', 'Warranties on structure, elevator and AC'],
      ar: ['على مسافة قصيرة سيراً من الكورنيش', 'تراس علوي بإطلالة على البحر', 'مسبح بشلالات', 'جناحان رئيسيان بغرف ملابس', 'مصعد ونظام منزل ذكي', 'ضمانات على الهيكل والمصعد والتكييف'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'al-bandar-villas-north-obhur', sourceRef: null, status: 'available', category: 'buy', type: 'villa', featured: false,
    title: { en: 'Al Bandar Villas, North Obhur', ar: 'فلل البندر، أبحر الشمالية' },
    location: loc({ en: 'Al Bandar, North Obhur', ar: 'البندر، أبحر الشمالية' }),
    price: { amount: 3150000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: 6, baths: 8, areaSqm: 300, plotSqm: null, yearBuilt: null, floors: 3 },
    folder: 'modern-villas-for-sale-in-al-bandar-north-obhur',
    images: [[20, 'pool'], [44, 'pool_night'], [1, 'entrance'], [2, 'courtyard'], [19, 'living'], [15, 'staircase'], [11, 'living'], [23, 'bedroom'], [26, 'bathroom'], [36, 'terrace']],
    description: {
      en: [
        'A collection of contemporary villas in Al Bandar, North Obhur, each with six master bedrooms and eight bathrooms on a 300-square-metre footprint. Every villa has a private pool and an elevator, with the latest home technology throughout.',
        'The ground floor holds two living rooms and a dining room overlooking the pool, a kitchen with a separate preparation kitchen and two bathrooms. Four master bedrooms and a family living area occupy the first floor; the second floor adds two further master bedrooms, a maid\'s room with bathroom and a private terrace.',
        'Prices start from SAR 3,150,000. A quiet northern address with the Obhur shore close by.',
      ],
      ar: [
        'مجموعة من الفلل العصرية في حي البندر بأبحر الشمالية، تضم كل منها ست غرف نوم رئيسية وثماني دورات مياه على مساحة 300 متر مربع. لكل فيلا مسبح خاص ومصعد، مع أحدث التقنيات المنزلية.',
        'يضم الطابق الأرضي صالتين وغرفة طعام تطل على المسبح ومطبخاً بمطبخ تحضير منفصل وحمامين. وفي الطابق الأول أربع غرف نوم رئيسية وصالة عائلية، ويضيف الطابق الثاني غرفتي نوم رئيسيتين وغرفة خادمة بحمام وتراساً خاصاً.',
        'تبدأ الأسعار من 3,150,000 ريال سعودي. عنوان شمالي هادئ على مقربة من شاطئ أبحر.',
      ],
    },
    highlights: {
      en: ['Six master bedrooms, eight bathrooms', 'Private pool in every villa', 'Elevator in every villa', 'Separate preparation kitchen', 'Private second-floor terrace', 'From SAR 3,150,000'],
      ar: ['ست غرف نوم رئيسية وثماني دورات مياه', 'مسبح خاص في كل فيلا', 'مصعد في كل فيلا', 'مطبخ تحضير منفصل', 'تراس خاص في الطابق الثاني', 'ابتداءً من 3,150,000 ريال سعودي'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'duplex-penthouse-al-salamah', sourceRef: null, status: 'available', category: 'buy', type: 'penthouse', featured: false,
    title: { en: 'Duplex Penthouse, Al Salamah', ar: 'بنتهاوس دوبلكس، السلامة' },
    location: loc({ en: 'Al Salamah', ar: 'السلامة' }),
    price: { amount: 1550000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: 3, baths: 6, areaSqm: 214, plotSqm: null, yearBuilt: null, floors: 2 },
    folder: 'penthouse-al-salama',
    images: [[5, 'living'], [32, 'exterior'], [10, 'view'], [1, 'entrance'], [9, 'living'], [16, 'staircase'], [23, 'bedroom'], [21, 'bathroom'], [12, 'living']],
    description: {
      en: [
        'A two-storey penthouse of 214 square metres in Al Salamah, with private entrances on both levels, insulated windows and a smart-home installation that includes lighting control, built-in speakers and a central vacuum system.',
        'The lower level holds the majlis, dining room and an American-style kitchen, with two bathrooms. Upstairs are the master bedroom, two further bedrooms, a living room and the maid\'s room. A driver\'s room with bathroom and a parking space are included.',
      ],
      ar: [
        'بنتهاوس من طابقين بمساحة 214 متراً مربعاً في حي السلامة، بمدخلين خاصين على المستويين ونوافذ معزولة ونظام منزل ذكي يشمل التحكم في الإضاءة وسماعات مدمجة ونظام تنظيف مركزي.',
        'يضم المستوى الأول المجلس وغرفة الطعام ومطبخاً أمريكياً وحمامين. وفي المستوى العلوي غرفة النوم الرئيسية وغرفتا نوم وصالة وغرفة الخادمة. يشمل العقار غرفة سائق بحمام وموقف سيارة.',
      ],
    },
    highlights: {
      en: ['Two floors, 214 sqm', 'Private entrance on each level', 'Smart lighting and built-in speakers', 'Central vacuum system', 'Maid\'s and driver\'s rooms', 'From SAR 1,550,000'],
      ar: ['طابقان بمساحة 214 متراً مربعاً', 'مدخل خاص لكل مستوى', 'إضاءة ذكية وسماعات مدمجة', 'نظام تنظيف مركزي', 'غرفة خادمة وغرفة سائق', 'ابتداءً من 1,550,000 ريال سعودي'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'nobal-five-al-rawdah', sourceRef: 'APT-030', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'NOBAL Five, Al Rawdah', ar: 'نوبال 5، الروضة' },
    location: loc({ en: 'Al Rawdah', ar: 'الروضة' }),
    price: { amount: 1800000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 3, baths: 5, areaSqm: 307, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'nobal-5',
    images: [[1, 'facade_night'], [0, 'exterior'], [10, 'lobby'], [9, 'living'], [12, 'staircase'], [5, 'living'], [16, 'bathroom'], [18, 'bathroom']],
    description: {
      en: [
        'NOBAL Five is a building of five residences in Al Rawdah, one apartment per floor, each occupying its entire level with a private elevator. The apartment measures 307 square metres and holds three master bedrooms, five bathrooms, a maid\'s room, a large living room and a modern kitchen.',
        'Finishes include porcelain and parquet flooring and high-grade sanitaryware, with a smart-home system, central air conditioning and two private parking spaces. The developer provides a ten-year structural warranty backed by Malath Insurance, alongside warranties on plumbing, waterproofing, elevators and the underground tank.',
      ],
      ar: [
        'نوبال 5 مبنى من خمسة مساكن في حي الروضة، شقة واحدة في كل طابق تشغل مستواها بالكامل بمصعد خاص. تبلغ مساحة الشقة 307 أمتار مربعة وتضم ثلاث غرف نوم رئيسية وخمس دورات مياه وغرفة خادمة وصالة واسعة ومطبخاً حديثاً.',
        'تشمل التشطيبات أرضيات البورسلان والباركيه وأدوات صحية عالية الجودة، مع نظام منزل ذكي وتكييف مركزي وموقفين خاصين. يقدم المطور ضماناً إنشائياً لعشر سنوات بدعم من شركة ملاذ للتأمين، إلى جانب ضمانات على السباكة والعزل المائي والمصاعد والخزان الأرضي.',
      ],
    },
    highlights: {
      en: ['One residence per floor', 'Private elevator', '307 sqm, three master bedrooms', 'Two private parking spaces', 'Smart-home system', 'Ten-year structural warranty'],
      ar: ['مسكن واحد في كل طابق', 'مصعد خاص', '307 أمتار مربعة وثلاث غرف نوم رئيسية', 'موقفان خاصان', 'نظام منزل ذكي', 'ضمان إنشائي لعشر سنوات'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'al-zahra-residences', sourceRef: 'APT-046', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Al Zahra Residences', ar: 'شقق الزهراء' },
    location: loc({ en: 'Al Zahra', ar: 'الزهراء' }),
    price: { amount: 1450000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: 3, baths: null, areaSqm: 200, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'al-zahrah-apartment',
    images: [[21, 'facade_night'], [10, 'exterior'], [11, 'lobby'], [25, 'living'], [14, 'balcony'], [12, 'living'], [18, 'view'], [4, 'bathroom'], [19, 'terrace']],
    virtualTourUrl: 'https://my.matterport.com/show/?m=dRurtVJ1zhh&brand=0',
    description: {
      en: [
        'A new low-density building of nine residences in Al Zahra, between King Road and Prince Sultan Street, with two apartments per floor over five floors. The standard residence measures 200 square metres and holds three master bedrooms, a large lounge, an open kitchen, a maid\'s room with bathroom and a balcony.',
        'A rooftop residence of 400 square metres offers four master bedrooms, seven bathrooms and a large terrace. The building has two separate entrances, an elevator to every floor, private parking for each unit, central air conditioning and workmanship warranties. A full 3D virtual tour of the apartment is available.',
      ],
      ar: [
        'مبنى جديد منخفض الكثافة من تسعة مساكن في حي الزهراء، بين طريق الملك وشارع الأمير سلطان، بشقتين في كل طابق على خمسة طوابق. تبلغ مساحة الشقة القياسية 200 متر مربع وتضم ثلاث غرف نوم رئيسية وصالة واسعة ومطبخاً مفتوحاً وغرفة خادمة بحمام وشرفة.',
        'يوفر مسكن السطح البالغ 400 متر مربع أربع غرف نوم رئيسية وسبع دورات مياه وتراساً واسعاً. للمبنى مدخلان منفصلان ومصعد إلى كل الطوابق وموقف خاص لكل وحدة وتكييف مركزي وضمانات على التنفيذ. تتوفر جولة افتراضية ثلاثية الأبعاد كاملة داخل الشقة.',
      ],
    },
    highlights: {
      en: ['Two apartments per floor', 'Three master bedrooms in 200 sqm', '400 sqm rooftop residence with terrace', 'Private parking for each unit', '3D virtual tour available', 'From SAR 1,450,000'],
      ar: ['شقتان في كل طابق', 'ثلاث غرف نوم رئيسية في 200 متر مربع', 'مسكن سطح بمساحة 400 متر مربع مع تراس', 'موقف خاص لكل وحدة', 'جولة افتراضية ثلاثية الأبعاد', 'ابتداءً من 1,450,000 ريال سعودي'],
    },
    listedAt: '2026-07-04',
  },
  {
    slug: 'villa-al-shati-1', sourceRef: 'VIL-004', status: 'sold', category: 'buy', type: 'villa', featured: false,
    title: { en: 'Villa Al Shati 1', ar: 'فيلا الشاطئ 1' },
    location: loc({ en: 'Al Shati 1', ar: 'الشاطئ 1' }),
    price: { amount: 7500000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 8, areaSqm: 750, plotSqm: 660, yearBuilt: null, floors: 3 },
    folder: 'villa-al-shati-1',
    images: [[9, 'pool'], [5, 'exterior'], [3, 'entrance'], [33, 'hall'], [16, 'living'], [21, 'kitchen'], [20, 'staircase'], [52, 'pool_night']],
    description: {
      en: [
        'A villa a few steps from the Corniche in Al Shati 1, set on 660 square metres with 750 square metres of built space and entrances from two wide streets. The house has a private pool, a marble-finished American kitchen, all-marble floors and a northern façade overlooking a large garden.',
        'The ground floor holds three reception rooms, an office, a kitchen and a living room facing the pool. Upstairs, a large hall overlooks the pool alongside two master bedrooms with dressing rooms and two further bedrooms. The second floor adds a bedroom suite with kitchenette, a large bedroom for three, a laundry and a rooftop terrace. Garage for three cars and a guard\'s room with street entrance.',
        'Sold. Shown here as a record of the residences we have handled; similar homes in Al Shati are available on request.',
      ],
      ar: [
        'فيلا على خطوات من الكورنيش في حي الشاطئ 1، على أرض بمساحة 660 متراً مربعاً ومساحة بناء 750 متراً مربعاً، بمدخلين من شارعين عريضين. للمنزل مسبح خاص ومطبخ أمريكي بتشطيبات رخامية وأرضيات رخامية كاملة وواجهة شمالية تطل على حديقة كبيرة.',
        'يضم الطابق الأرضي ثلاث صالات استقبال ومكتباً ومطبخاً وغرفة معيشة تطل على المسبح. وفي الطابق الأول قاعة واسعة تطل على المسبح وغرفتا نوم رئيسيتان بغرف ملابس وغرفتا نوم إضافيتان. ويضيف الطابق الثاني جناح نوم بمطبخ صغير وغرفة نوم كبيرة لثلاثة أسرّة وغرفة غسيل وتراساً علوياً. مرآب لثلاث سيارات وغرفة حارس بمدخل من الشارع.',
        'تم البيع. نعرضها هنا توثيقاً للمساكن التي تولينا بيعها؛ تتوفر منازل مماثلة في حي الشاطئ عند الطلب.',
      ],
    },
    highlights: {
      en: ['Steps from the Corniche', '660 sqm plot, 750 sqm built', 'Private pool', 'Entrances from two streets', 'Three-car garage', 'Sold'],
      ar: ['على خطوات من الكورنيش', 'أرض 660 متراً مربعاً ومساحة بناء 750 متراً مربعاً', 'مسبح خاص', 'مدخلان من شارعين', 'مرآب لثلاث سيارات', 'تم البيع'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'park-facing-villa-al-khalidiyah', sourceRef: 'VIL-039', status: 'sold', category: 'buy', type: 'villa', featured: false,
    title: { en: 'Park-Facing Villa, Al Khalidiyah', ar: 'فيلا مقابل الحديقة، الخالدية' },
    location: loc({ en: 'Al Khalidiyah', ar: 'الخالدية' }),
    price: { amount: 4600000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 5, baths: 7, areaSqm: 420, plotSqm: null, yearBuilt: null, floors: 3 },
    folder: 'villa-al-khalidiyah',
    images: [[102, 'facade_night'], [96, 'pool'], [85, 'exterior'], [17, 'living'], [66, 'hall'], [60, 'living'], [64, 'kitchen'], [33, 'bedroom'], [42, 'bathroom'], [5, 'terrace']],
    description: {
      en: [
        'A villa of 420 square metres directly opposite a park on Prince Sultan Street, a few steps from Sari Road in Al Khalidiyah. The house has two entrances, indoor parking for two cars, a pool with front and rear gardens, a large upper terrace and marble flooring throughout.',
        'Two guest reception rooms, a salon and dining area, a living room facing the pool and the main kitchen make up the ground floor. The first floor holds two master bedrooms with dressing rooms, two further bedrooms, a living room and a service kitchen. A master suite overlooking the garden, the maid\'s room, laundry and a terrace occupy the roof. Fitted with a Fuji elevator, smart-home system, central air conditioning and double-glazed windows.',
        'Sold. Shown as a record of the residences we have handled.',
      ],
      ar: [
        'فيلا بمساحة 420 متراً مربعاً مقابل حديقة على شارع الأمير سلطان مباشرة، على خطوات من طريق صاري في حي الخالدية. للمنزل مدخلان ومواقف داخلية لسيارتين ومسبح مع حديقتين أمامية وخلفية وتراس علوي واسع وأرضيات رخامية في كل الأرجاء.',
        'يتكون الطابق الأرضي من مجلسين للضيوف وصالون ومنطقة طعام وغرفة معيشة تطل على المسبح والمطبخ الرئيسي. ويضم الطابق الأول غرفتي نوم رئيسيتين بغرف ملابس وغرفتي نوم إضافيتين وصالة ومطبخ خدمة. وفي السطح جناح رئيسي يطل على الحديقة وغرفة الخادمة وغرفة الغسيل وتراس. الفيلا مزودة بمصعد فوجي ونظام منزل ذكي وتكييف مركزي ونوافذ مزدوجة الزجاج.',
        'تم البيع. نعرضها توثيقاً للمساكن التي تولينا بيعها.',
      ],
    },
    highlights: {
      en: ['Opposite a park on Prince Sultan Street', 'Pool with front and rear gardens', 'Two master suites with dressing rooms', 'Fuji elevator and smart-home system', 'Indoor parking for two cars', 'Sold'],
      ar: ['مقابل حديقة على شارع الأمير سلطان', 'مسبح مع حديقتين أمامية وخلفية', 'جناحان رئيسيان بغرف ملابس', 'مصعد فوجي ونظام منزل ذكي', 'مواقف داخلية لسيارتين', 'تم البيع'],
    },
    listedAt: '2026-03-21',
  },

  // ───────────────────────────── RENT ─────────────────────────────
  {
    slug: 'villa-for-rent-al-shati-2', sourceRef: null, status: 'available', category: 'rent', type: 'villa', featured: false,
    title: { en: 'Villa for Rent, Al Shati 2', ar: 'فيلا للإيجار، الشاطئ 2' },
    location: loc({ en: 'Al Shati 2', ar: 'الشاطئ 2' }),
    price: { amount: 150000, currency: 'SAR', from: false, period: 'year', onRequest: false },
    specs: { beds: 4, baths: 5, areaSqm: null, plotSqm: null, yearBuilt: null, floors: 3 },
    folder: 'villa-for-rent-al-shati-2',
    images: [[25, 'facade_night'], [28, 'exterior'], [24, 'entrance'], [4, 'living'], [9, 'staircase'], [20, 'kitchen'], [8, 'living'], [12, 'bathroom']],
    description: {
      en: [
        'A four-bedroom villa in Al Shati 2, behind the Rosewood Hotel and the Damac tower, a three-minute walk from the Corniche. The house has a living room, a main kitchen and a kitchenette, five bathrooms and a surveillance system that can be viewed from the television.',
        'Two master bedrooms occupy the first floor. On the second floor, the principal bedroom opens onto a balcony with views of the sea, Damac Tower and the Rosewood Hotel, alongside a maid\'s room and a laundry. Fakeeh Aquarium, Boulevard Mall, Prestige Mall and King\'s College Hospital are all close by, with easy access to King Road.',
      ],
      ar: [
        'فيلا بأربع غرف نوم في حي الشاطئ 2، خلف فندق روزوود وبرج داماك، على ثلاث دقائق سيراً من الكورنيش. يضم المنزل صالة ومطبخاً رئيسياً ومطبخاً صغيراً وخمس دورات مياه ونظام كاميرات مراقبة يمكن متابعته من شاشة التلفاز.',
        'تشغل غرفتا نوم رئيسيتان الطابق الأول. وفي الطابق الثاني تنفتح غرفة النوم الرئيسية على شرفة تطل على البحر وبرج داماك وفندق روزوود، إلى جانب غرفة خادمة وغرفة غسيل. عالم فقيه للأحياء المائية وبوليفارد مول وبرستيج مول ومستشفى كينجز كوليدج جميعها قريبة، مع وصول سهل إلى طريق الملك.',
      ],
    },
    highlights: {
      en: ['Three-minute walk to the Corniche', 'Four master bedrooms', 'Balcony with sea views', 'Surveillance system', 'Near Boulevard and Prestige malls', 'Annual rent SAR 150,000'],
      ar: ['ثلاث دقائق سيراً إلى الكورنيش', 'أربع غرف نوم رئيسية', 'شرفة بإطلالة على البحر', 'نظام مراقبة', 'قرب بوليفارد مول وبرستيج مول', 'إيجار سنوي 150,000 ريال سعودي'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'villa-for-rent-al-murjan', sourceRef: null, status: 'available', category: 'rent', type: 'villa', featured: false,
    title: { en: 'Villa for Rent, Al Murjan', ar: 'فيلا للإيجار، المرجان' },
    location: loc({ en: 'Al Murjan', ar: 'المرجان' }),
    price: { amount: 250000, currency: 'SAR', from: false, period: 'year', onRequest: false },
    specs: { beds: 5, baths: 7, areaSqm: 518, plotSqm: 364, yearBuilt: null, floors: 3 },
    folder: 'modern-luxury-villas-al-murjan',
    images: [[0, 'facade_night'], [21, 'exterior'], [6, 'pool'], [14, 'entrance'], [7, 'living'], [3, 'staircase'], [17, 'living'], [10, 'skyline']],
    description: {
      en: [
        'A contemporary villa for rent in Al Murjan, behind King Road and steps from the Corniche. The house has 518 square metres of built space on a 364-square-metre plot, with a private pool, an internal elevator, central air conditioning and two independent entrances.',
        'An open reception area, an elegant kitchen and two bathrooms occupy the ground floor. Four master bedrooms, a living room and a small kitchen are on the first floor. The roof level holds a fifth master bedroom with a balcony over King Road, a maid\'s room and a laundry.',
      ],
      ar: [
        'فيلا عصرية للإيجار في حي المرجان، خلف طريق الملك وعلى خطوات من الكورنيش. يوفر المنزل 518 متراً مربعاً من المساحة المبنية على أرض بمساحة 364 متراً مربعاً، مع مسبح خاص ومصعد داخلي وتكييف مركزي ومدخلين مستقلين.',
        'يضم الطابق الأرضي منطقة استقبال مفتوحة ومطبخاً أنيقاً وحمامين. وفي الطابق الأول أربع غرف نوم رئيسية وصالة ومطبخ صغير. ويضم الطابق العلوي غرفة نوم رئيسية خامسة بشرفة تطل على طريق الملك وغرفة خادمة وغرفة غسيل.',
      ],
    },
    highlights: {
      en: ['Steps from the Corniche', 'Private pool', 'Internal elevator', 'Five master bedrooms', 'Two independent entrances', 'Annual rent SAR 250,000'],
      ar: ['على خطوات من الكورنيش', 'مسبح خاص', 'مصعد داخلي', 'خمس غرف نوم رئيسية', 'مدخلان مستقلان', 'إيجار سنوي 250,000 ريال سعودي'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'renovated-villa-for-rent-al-murjan', sourceRef: null, status: 'available', category: 'rent', type: 'villa', featured: false,
    title: { en: 'Renovated Villa for Rent, Al Murjan', ar: 'فيلا مجددة للإيجار، المرجان' },
    location: loc({ en: 'Al Murjan', ar: 'المرجان' }),
    price: { amount: 165000, currency: 'SAR', from: false, period: 'year', onRequest: false },
    specs: { beds: 4, baths: 7, areaSqm: 500, plotSqm: 350, yearBuilt: null, floors: 3 },
    folder: 'fully-renovated-villa-al-murjan',
    images: [[1, 'pool'], [0, 'exterior'], [8, 'living'], [5, 'kitchen'], [3, 'living'], [10, 'bedroom'], [7, 'living'], [12, 'bathroom']],
    description: {
      en: [
        'A fully renovated villa for rent in the heart of Al Murjan, moments from the Corniche and King Road. The house offers 500 square metres of built space on a 350-square-metre plot, with a private pool, two independent entrances and high-quality finishing throughout.',
        'The ground floor holds a reception area, a dining area, a living room overlooking the pool, the kitchen and two bathrooms. Four master bedrooms, a living room and a small kitchen are on the first floor; the roof level has a further bedroom, a maid\'s room and a laundry.',
      ],
      ar: [
        'فيلا مجددة بالكامل للإيجار في قلب حي المرجان، على مقربة من الكورنيش وطريق الملك. يوفر المنزل 500 متر مربع من المساحة المبنية على أرض بمساحة 350 متراً مربعاً، مع مسبح خاص ومدخلين مستقلين وتشطيبات عالية الجودة.',
        'يضم الطابق الأرضي منطقة استقبال ومنطقة طعام وغرفة معيشة تطل على المسبح والمطبخ وحمامين. وفي الطابق الأول أربع غرف نوم رئيسية وصالة ومطبخ صغير، وفي الطابق العلوي غرفة نوم إضافية وغرفة خادمة وغرفة غسيل.',
      ],
    },
    highlights: {
      en: ['Fully renovated', 'Private pool', 'Four master bedrooms', 'Two independent entrances', 'Moments from the Corniche', 'Annual rent SAR 165,000'],
      ar: ['مجددة بالكامل', 'مسبح خاص', 'أربع غرف نوم رئيسية', 'مدخلان مستقلان', 'على مقربة من الكورنيش', 'إيجار سنوي 165,000 ريال سعودي'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'villa-for-rent-al-mohammadiyah', sourceRef: null, status: 'available', category: 'rent', type: 'villa', featured: false,
    title: { en: 'Villa for Rent, Al Mohammadiyah', ar: 'فيلا للإيجار، المحمدية' },
    location: loc({ en: 'Al Mohammadiyah', ar: 'المحمدية' }),
    price: { amount: 160000, currency: 'SAR', from: false, period: 'year', onRequest: false },
    specs: { beds: 4, baths: 6, areaSqm: 500, plotSqm: null, yearBuilt: null, floors: 3 },
    folder: 'villa-al-mohamediya',
    images: [[4, 'entrance'], [0, 'exterior'], [3, 'courtyard'], [16, 'living'], [5, 'staircase'], [13, 'living'], [10, 'bathroom'], [18, 'staircase']],
    description: {
      en: [
        'A 500-square-metre villa for rent in Al Mohammadiyah, finished in marble with a smart-home installation. Four master bedrooms, six bathrooms and three living rooms are arranged over three floors.',
        'Two living rooms, the kitchen and two bathrooms occupy the ground floor. The first floor holds the master bedroom, three further bedrooms, two bathrooms and a living room. A maid\'s room with bathroom and a laundry are on the second floor. Parking for one car.',
      ],
      ar: [
        'فيلا بمساحة 500 متر مربع للإيجار في حي المحمدية، بتشطيبات رخامية ونظام منزل ذكي. أربع غرف نوم رئيسية وست دورات مياه وثلاث صالات موزعة على ثلاثة طوابق.',
        'يضم الطابق الأرضي صالتين والمطبخ وحمامين. وفي الطابق الأول غرفة النوم الرئيسية وثلاث غرف نوم أخرى وحمامان وصالة. وفي الطابق الثاني غرفة خادمة بحمام وغرفة غسيل. موقف لسيارة واحدة.',
      ],
    },
    highlights: {
      en: ['500 sqm over three floors', 'Marble finishes', 'Smart-home system', 'Four master bedrooms', 'Three living rooms', 'Annual rent SAR 160,000'],
      ar: ['500 متر مربع على ثلاثة طوابق', 'تشطيبات رخامية', 'نظام منزل ذكي', 'أربع غرف نوم رئيسية', 'ثلاث صالات', 'إيجار سنوي 160,000 ريال سعودي'],
    },
    listedAt: '2026-09-05',
  },

  // ───────────────────────────── OFF-PLAN ─────────────────────────────
  {
    slug: 'trump-tower-jeddah', sourceRef: 'APT-037', status: 'available', category: 'off-plan', type: 'apartment', featured: true,
    title: { en: 'Trump Tower Jeddah', ar: 'برج ترامب جدة' },
    location: loc({ en: 'Al Shati, Corniche', ar: 'الشاطئ، الكورنيش' }),
    price: { amount: 3200000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'trump-tower-jeddah',
    images: [[9, 'tower'], [11, 'facade_night'], [10, 'sea'], [7, 'lobby'], [3, 'living'], [6, 'dining'], [0, 'master'], [4, 'lounge'], [8, 'bar'], [5, 'gym']],
    description: {
      en: [
        'Trump Tower Jeddah rises on the Corniche in Al Shati, a residential landmark overlooking the Red Sea. The tower offers one- to four-bedroom residences from 70 to 365 square metres and three- and four-bedroom penthouses, all with uninterrupted sea views.',
        'Residents have access to the Trump Private Club, fine dining, a cigar lounge, meeting rooms, a pool and jacuzzi, a children\'s pool, a gym and a yoga zone, with concierge service around the clock. Completion is scheduled for December 2029.',
        'Prices start from SAR 3,200,000.',
      ],
      ar: [
        'يرتفع برج ترامب جدة على الكورنيش في حي الشاطئ، معلماً سكنياً يطل على البحر الأحمر. يقدم البرج مساكن من غرفة إلى أربع غرف نوم بمساحات من 70 إلى 365 متراً مربعاً، وبنتهاوس من ثلاث وأربع غرف نوم، جميعها بإطلالات بحرية غير محجوبة.',
        'يتمتع السكان بعضوية نادي ترامب الخاص ومطاعم راقية وصالة سيجار وقاعات اجتماعات ومسبح وجاكوزي ومسبح للأطفال ونادٍ رياضي ومنطقة يوغا، مع خدمة كونسيرج على مدار الساعة. التسليم المتوقع في ديسمبر 2029.',
        'تبدأ الأسعار من 3,200,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['On the Corniche, Al Shati', 'Uninterrupted Red Sea views', '1–4 bedroom residences and penthouses', 'Trump Private Club and 24/7 concierge', 'Completion December 2029', 'From SAR 3,200,000'],
      ar: ['على الكورنيش في حي الشاطئ', 'إطلالات غير محجوبة على البحر الأحمر', 'مساكن من غرفة إلى أربع غرف وبنتهاوس', 'نادي ترامب الخاص وكونسيرج على مدار الساعة', 'التسليم في ديسمبر 2029', 'ابتداءً من 3,200,000 ريال سعودي'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'trump-plaza-jeddah', sourceRef: 'APT-036', status: 'available', category: 'off-plan', type: 'apartment', featured: false,
    title: { en: 'Trump Plaza Jeddah', ar: 'ترامب بلازا جدة' },
    location: loc({ en: 'Al Shati', ar: 'الشاطئ' }),
    price: { amount: 1750000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'trump-plaza-jeddah',
    images: [[6, 'exterior'], [2, 'entrance'], [7, 'courtyard'], [4, 'living'], [3, 'dining'], [5, 'master'], [12, 'indoor_pool'], [10, 'spa'], [17, 'gym'], [15, 'bar']],
    description: {
      en: [
        'Trump Plaza Jeddah offers fully furnished, Trump-branded residences in one-, two- and three-bedroom layouts from 70 to 147 square metres, across seven floors in Al Shati. Interiors are finished to hotel standard and delivered ready to move in, with à la carte services.',
        'A single corridor connects residents to offices, wellness facilities, dining and daily conveniences. The Vitality Club, a members-only performance and wellness destination, brings together golf simulator rooms, a spa with sports medicine and physiotherapy, a recovery suite, swimming pools, fine dining, a cigar and library lounge, members\' lounges and day care.',
        'Completion is scheduled for December 2030. Prices start from SAR 1,750,000.',
      ],
      ar: [
        'يقدم ترامب بلازا جدة مساكن مفروشة بالكامل بعلامة ترامب، بتصاميم من غرفة وغرفتين وثلاث غرف نوم بمساحات من 70 إلى 147 متراً مربعاً، على سبعة طوابق في حي الشاطئ. التشطيبات الداخلية بمستوى فندقي وجاهزة للسكن مع خدمات حسب الطلب.',
        'يربط ممر واحد السكان بالمكاتب ومرافق العافية والمطاعم واحتياجات الحياة اليومية. ويجمع نادي فايتاليتي، وهو وجهة للأداء والعافية مخصصة للأعضاء، غرف محاكاة الجولف وسبا مع الطب الرياضي والعلاج الطبيعي وجناح استشفاء ومسابح ومطاعم راقية وصالة سيجار ومكتبة وصالات للأعضاء وحضانة.',
        'التسليم المتوقع في ديسمبر 2030. تبدأ الأسعار من 1,750,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['Fully furnished, Trump-branded residences', '1–3 bedrooms, 70–147 sqm', 'Vitality Club: spa, pools, golf simulators', 'Hotel-standard interiors, move-in ready', 'Completion December 2030', 'From SAR 1,750,000'],
      ar: ['مساكن مفروشة بالكامل بعلامة ترامب', 'من غرفة إلى ثلاث غرف، 70–147 متراً مربعاً', 'نادي فايتاليتي: سبا ومسابح ومحاكيات جولف', 'تشطيبات بمستوى فندقي وجاهزة للسكن', 'التسليم في ديسمبر 2030', 'ابتداءً من 1,750,000 ريال سعودي'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'nobal-arista-al-khalidiyah', sourceRef: 'VIL-031', status: 'available', category: 'off-plan', type: 'villa', featured: false,
    title: { en: 'NOBAL Arista, Al Khalidiyah', ar: 'نوبال أريستا، الخالدية' },
    location: loc({ en: 'Al Khalidiyah', ar: 'الخالدية' }),
    price: { amount: 5000000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 4, baths: 7, areaSqm: 304, plotSqm: null, yearBuilt: null, floors: 3 },
    folder: 'nobal-arista',
    images: [[2, 'entrance'], [0, 'render'], [9, 'living'], [3, 'dining'], [4, 'living'], [6, 'master'], [8, 'living'], [7, 'bathroom']],
    description: {
      en: [
        'NOBAL Arista is a limited collection of six villas in Al Khalidiyah, each with 304 square metres of built space over three floors, four bedrooms and seven bathrooms, a private garden and pool, and rooms for driver and maid.',
        'The ground floor of 213 square metres holds a guest salon, living and dining areas, the kitchen, the maid\'s room and laundry, and opens onto the garden and pool. Three en-suite bedrooms with walk-in closets and balconies occupy the first floor. The second floor is given to the master suite, a family lounge and a rooftop terrace.',
        'Finishes include porcelain, parquet and high-performance windows, with a smart entry system, CCTV, central air conditioning and a fully fitted kitchen. A ten-year structural warranty backed by Malath Insurance and a year of free maintenance are included.',
      ],
      ar: [
        'نوبال أريستا مجموعة محدودة من ست فلل في حي الخالدية، لكل منها 304 أمتار مربعة من المساحة المبنية على ثلاثة طوابق، بأربع غرف نوم وسبع دورات مياه وحديقة ومسبح خاصين وغرفتين للسائق والخادمة.',
        'يضم الطابق الأرضي البالغ 213 متراً مربعاً صالون ضيوف ومنطقتي معيشة وطعام والمطبخ وغرفة الخادمة وغرفة الغسيل، وينفتح على الحديقة والمسبح. وفي الطابق الأول ثلاث غرف نوم بحمامات خاصة وغرف ملابس وشرفات. أما الطابق الثاني فمخصص للجناح الرئيسي وصالة عائلية وتراس علوي.',
        'تشمل التشطيبات البورسلان والباركيه والنوافذ عالية الأداء، مع نظام دخول ذكي وكاميرات مراقبة وتكييف مركزي ومطبخ مجهز بالكامل. يشمل العرض ضماناً إنشائياً لعشر سنوات بدعم من شركة ملاذ للتأمين وسنة من الصيانة المجانية.',
      ],
    },
    highlights: {
      en: ['One of six villas only', 'Private garden and pool', 'Master suite with rooftop terrace', 'Four bedrooms, seven bathrooms', 'Smart entry and CCTV', 'Ten-year structural warranty'],
      ar: ['واحدة من ست فلل فقط', 'حديقة ومسبح خاصان', 'جناح رئيسي بتراس علوي', 'أربع غرف نوم وسبع دورات مياه', 'دخول ذكي وكاميرات مراقبة', 'ضمان إنشائي لعشر سنوات'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'kayan-residence-al-nahda', sourceRef: null, status: 'available', category: 'off-plan', type: 'apartment', featured: false,
    title: { en: 'Kayan Residence, Al Nahda', ar: 'كيان ريزيدنس، النهضة' },
    location: loc({ en: 'Al Nahda', ar: 'النهضة' }),
    price: { amount: 940000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: null, baths: 3, areaSqm: 136, plotSqm: null, yearBuilt: 2024, floors: null },
    project: KAYAN_PROJECT, // parent project page; units share its developer renders
    folder: 'kian-residence',
    images: [[17, 'exterior'], [13, 'facade_night'], [16, 'lobby'], [0, 'living'], [2, 'kitchen'], [3, 'living'], [10, 'cafe'], [14, 'gym'], [11, 'terrace']],
    description: {
      en: [
        'Kayan Residence brings hotel-style living to Al Nahda, minutes from Jeddah\'s principal destinations. Apartments of about 136 square metres offer two to three bedrooms, three bathrooms, a large living room and a modern kitchen, each served by its own private elevator; individual units are listed separately with their exact layout and price.',
        'The building offers a coffee-shop area, a children\'s play area, smart access and private parking, with a smart-home system, central air conditioning and quality finishes in every residence. Priced at SAR 980,000.',
      ],
      ar: [
        'يقدم كيان ريزيدنس أسلوب سكن فندقياً في حي النهضة، على دقائق من أبرز وجهات جدة. تضم الشقق، بمساحة نحو 136 متراً مربعاً، غرفتي نوم إلى ثلاث غرف وثلاث دورات مياه وصالة واسعة ومطبخاً حديثاً، ويخدم كل شقة مصعد خاص؛ وتُعرض الوحدات منفردةً بمخططها وسعرها الدقيقين.',
        'يوفر المبنى منطقة مقهى ومنطقة ألعاب للأطفال ودخولاً ذكياً ومواقف خاصة، مع نظام منزل ذكي وتكييف مركزي وتشطيبات عالية الجودة في كل مسكن. السعر 980,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['Private elevator for each apartment', 'Hotel-style residence', 'Coffee-shop and children\'s areas', 'Smart access and smart-home system', 'About 136 sqm, two to three bedrooms', 'From SAR 940,000'],
      ar: ['مصعد خاص لكل شقة', 'سكن بأسلوب فندقي', 'مقهى ومنطقة للأطفال', 'دخول ذكي ونظام منزل ذكي', 'نحو 136 متراً مربعاً، غرفتا نوم إلى ثلاث', 'ابتداءً من 940,000 ريال سعودي'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'dari-ii-al-salamah', sourceRef: 'APT-045', status: 'available', category: 'off-plan', type: 'apartment', featured: false,
    title: { en: 'Dari II, Al Salamah', ar: 'داري 2، السلامة' },
    location: loc({ en: 'Al Salamah', ar: 'السلامة' }),
    price: { amount: 1600000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'dari-2',
    images: [[7, 'aerial'], [19, 'rooftop_pool'], [14, 'pool_night'], [4, 'lobby'], [25, 'lounge'], [5, 'living'], [6, 'kitchen'], [11, 'event_hall'], [8, 'gym'], [30, 'exterior']],
    description: {
      en: [
        'Dari II is a residential community in Al Salamah, central Jeddah, designed around minimalist architecture and warm natural finishes. Three- and four-bedroom apartments and a penthouse range from 164 to 383 square metres across five floors.',
        'Residents share a reception and welcome lounge, a gym, a swimming pool, an event hall and a children\'s play area, with schools, hospitals and cafés close at hand. Prices start from SAR 1,600,000.',
      ],
      ar: [
        'داري 2 مجتمع سكني في حي السلامة وسط جدة، صُمم حول عمارة بسيطة وتشطيبات طبيعية دافئة. تتراوح مساحات الشقق من ثلاث وأربع غرف نوم والبنتهاوس بين 164 و383 متراً مربعاً على خمسة طوابق.',
        'يتشارك السكان منطقة استقبال وصالة ترحيب ونادياً رياضياً ومسبحاً وقاعة مناسبات ومنطقة ألعاب للأطفال، مع قرب المدارس والمستشفيات والمقاهي. تبدأ الأسعار من 1,600,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['3–4 bedroom apartments and a penthouse', '164–383 sqm', 'Pool, gym and event hall', 'Central Jeddah location', 'Minimalist design, natural finishes', 'From SAR 1,600,000'],
      ar: ['شقق من ثلاث وأربع غرف وبنتهاوس', '164–383 متراً مربعاً', 'مسبح ونادٍ رياضي وقاعة مناسبات', 'موقع وسط جدة', 'تصميم بسيط وتشطيبات طبيعية', 'ابتداءً من 1,600,000 ريال سعودي'],
    },
    listedAt: '2026-04-14',
  },
  {
    slug: 'marriott-residences-aida-muscat', sourceRef: 'APT-010', status: 'available', category: 'off-plan', type: 'apartment', featured: false,
    title: { en: 'Marriott Residences, AIDA, Muscat', ar: 'ماريوت ريزيدنسز، آيدا، مسقط' },
    location: loc({ en: 'AIDA', ar: 'آيدا' }, { en: 'Muscat', ar: 'مسقط' }, { en: 'Oman', ar: 'سلطنة عُمان' }, 'OM'),
    price: { amount: 1900000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'marriott-residences-aida-oman',
    images: [[5, 'pool'], [4, 'render'], [1, 'balcony'], [8, 'living'], [7, 'dining'], [6, 'kitchen'], [3, 'golf'], [2, 'view']],
    description: {
      en: [
        'Fully furnished residences under the Marriott name within AIDA, the coastal community at Muscat. One-, two- and three-bedroom apartments range from 60 to 194 square metres, with interiors delivered complete.',
        'Owners have concierge, reception, doorman and valet services, and access to AIDA\'s championship golf course, wellness centres, promenades, trails, parks, plazas with cafés and restaurants, swimming pools, a clubhouse and a private beach enclave. Completion is scheduled for September 2029.',
        'Freehold ownership is open to all nationalities, with a residency visa for investors. Prices start from SAR 1,900,000.',
      ],
      ar: [
        'مساكن مفروشة بالكامل تحمل اسم ماريوت ضمن آيدا، المجتمع الساحلي في مسقط. تتراوح مساحات الشقق من غرفة وغرفتين وثلاث غرف نوم بين 60 و194 متراً مربعاً، وتُسلم بتشطيباتها الداخلية كاملة.',
        'يحظى الملاك بخدمات الكونسيرج والاستقبال والبواب وصف السيارات، والوصول إلى ملعب الجولف بمواصفات البطولات في آيدا ومراكز العافية والممشى والمسارات والحدائق والساحات بمقاهيها ومطاعمها والمسابح والنادي ومنطقة الشاطئ الخاص. التسليم المتوقع في سبتمبر 2029.',
        'التملك الحر متاح لجميع الجنسيات مع تأشيرة إقامة للمستثمرين. تبدأ الأسعار من 1,900,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['Fully furnished Marriott residences', '1–3 bedrooms, 60–194 sqm', 'Championship golf course and private beach', 'Concierge, doorman and valet', 'Freehold for all nationalities', 'From SAR 1,900,000'],
      ar: ['مساكن ماريوت مفروشة بالكامل', 'من غرفة إلى ثلاث غرف، 60–194 متراً مربعاً', 'ملعب جولف بمواصفات البطولات وشاطئ خاص', 'كونسيرج وبواب وصف سيارات', 'تملك حر لجميع الجنسيات', 'ابتداءً من 1,900,000 ريال سعودي'],
    },
    listedAt: '2026-03-21',
  },

  // ───────────────────────────── INTERNATIONAL ─────────────────────────────
  {
    slug: 'palais-rose-le-vesinet', sourceRef: 'VIL-032', status: 'available', category: 'international', type: 'mansion', featured: true,
    title: { en: 'Palais Rose, Le Vésinet', ar: 'قصر بالي روز، لو فيزينيه' },
    location: loc({ en: 'Parc des Ibis, Île-de-France', ar: 'بارك دي زيبيس، إيل دو فرانس' }, { en: 'Le Vésinet', ar: 'لو فيزينيه' }, { en: 'France', ar: 'فرنسا' }, 'FR'),
    price: { amount: 38000000, currency: 'EUR', from: false, period: null, onRequest: false },
    specs: { beds: 8, baths: 16, areaSqm: 1769, plotSqm: 7000, yearBuilt: null, floors: 3 },
    folder: 'palais-rose',
    images: [[10, 'exterior'], [1, 'aerial'], [7, 'winter_garden'], [18, 'living'], [20, 'dining'], [22, 'living'], [9, 'kitchen'], [15, 'master'], [19, 'indoor_pool'], [6, 'grounds']],
    description: {
      en: [
        'Twenty minutes from Porte Maillot, within the Parc des Ibis in Le Vésinet, Palais Rose is a private estate inspired by the Grand Trianon. The main residence offers 1,769 square metres across the lower ground, garden and ground floors, set in 7,000 square metres of landscaped grounds with a Japanese garden, a rose garden, a central fountain, a greenhouse and a private football pitch.',
        'The ground floor holds the reception hall, a grand reception room, a formal living room, a winter garden, a La Cornue chef\'s kitchen, the dining room and a gallery. The garden level is private: a family living room, three bedroom suites and the owner\'s suite with his-and-hers dressing rooms and bathrooms. Below are a private cinema, a games room, a massage and yoga studio, an indoor pool with sauna and hammam, a gym, a squash court and a garage for three cars.',
        'The Hermitage House, an independent guest residence, has four en-suite bedrooms, a living room, an office and a kitchen. A caretaker\'s villa, a staff villa and estate-wide surveillance complete the domain.',
      ],
      ar: [
        'على عشرين دقيقة من بورت مايو، داخل بارك دي زيبيس في لو فيزينيه، يقف قصر بالي روز ضيعة خاصة مستوحاة من قصر تريانون الكبير. يوفر المسكن الرئيسي 1,769 متراً مربعاً على الطابق السفلي وطابق الحديقة والطابق الأرضي، وسط 7,000 متر مربع من الحدائق المنسقة تضم حديقة يابانية وحديقة ورود ونافورة مركزية ودفيئة وملعب كرة قدم خاصاً.',
        'يضم الطابق الأرضي بهو الاستقبال وقاعة استقبال كبرى وصالوناً رسمياً وحديقة شتوية ومطبخ طهاة من لا كورنو وغرفة الطعام ورواقاً. أما طابق الحديقة فخاص بالعائلة: صالة عائلية وثلاثة أجنحة نوم وجناح المالك بغرفتي ملابس وحمامين. وفي الأسفل سينما خاصة وغرفة ألعاب واستوديو للتدليك واليوغا ومسبح داخلي مع ساونا وحمّام وصالة رياضية وملعب اسكواش ومرآب لثلاث سيارات.',
        'يضم بيت الضيافة المستقل «الإرميتاج» أربع غرف نوم بحمامات خاصة وصالة ومكتباً ومطبخاً. وتكتمل الضيعة بفيلا للحارس وفيلا للعاملين ونظام مراقبة يغطي كامل الأرض.',
      ],
    },
    highlights: {
      en: ['1,769 sqm residence on 7,000 sqm of grounds', 'Inspired by the Grand Trianon', 'Indoor pool, sauna, hammam and squash court', 'Private cinema', 'Independent four-bedroom guest house', 'Twenty minutes from Paris'],
      ar: ['مسكن بمساحة 1,769 متراً مربعاً على أرض 7,000 متر مربع', 'مستوحى من قصر تريانون الكبير', 'مسبح داخلي وساونا وحمّام وملعب اسكواش', 'سينما خاصة', 'بيت ضيافة مستقل بأربع غرف نوم', 'على عشرين دقيقة من باريس'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'palais-venitien-cannes', sourceRef: 'VIL-033', status: 'sold', category: 'international', type: 'mansion', featured: false,
    title: { en: 'Palais Vénitien, Cannes', ar: 'قصر بالي فينيسيان، كان' },
    location: loc({ en: 'Cannes, Côte d\'Azur', ar: 'كان، الريفييرا الفرنسية' }, { en: 'Cannes', ar: 'كان' }, { en: 'France', ar: 'فرنسا' }, 'FR'),
    price: { amount: 120000000, currency: 'EUR', from: false, period: null, onRequest: false },
    specs: { beds: 12, baths: 16, areaSqm: 3000, plotSqm: 30000, yearBuilt: null, floors: 3 },
    folder: 'palais-venitien',
    images: [[27, 'pool'], [1, 'pool_night'], [5, 'terrace'], [17, 'hall'], [14, 'living'], [15, 'dining'], [10, 'indoor_pool'], [13, 'winter_garden'], [21, 'cinema'], [2, 'aerial']],
    description: {
      en: [
        'Palais Vénitien is a palatial residence above Cannes, inspired by the architecture of Byzantium and Venice and looking out over the town and the Mediterranean. The interior spans more than 2,000 square metres of monumental columns and mouldings, within an estate of three hectares.',
        'The garden level holds an entrance hall, a triple reception, a La Cornue kitchen, a winter-garden patio, four en-suite bedrooms and a private living room, with separate service quarters. The first floor is given to a master suite with two bathrooms and two dressing rooms, six further bedroom suites, two lounges, a breakfast room and terraces facing the sea and the mountains. An indoor spa with a 15-metre pool, jacuzzi and sauna, a garage for eight cars, cellars and a safe room lie below.',
        'Outside are a private lake, a tennis court, a 25-metre pool with a 12-by-5-metre whirlpool spa, a pool house with steam room, and a caretaker\'s villa and security lodge. Sold; shown here as a record of the residences we have represented.',
      ],
      ar: [
        'قصر بالي فينيسيان مسكن فخم فوق مدينة كان، مستوحى من عمارة بيزنطة والبندقية، يطل على المدينة والبحر الأبيض المتوسط. يمتد الداخل على أكثر من 2,000 متر مربع من الأعمدة الضخمة والزخارف، ضمن ضيعة بمساحة ثلاثة هكتارات.',
        'يضم طابق الحديقة بهو مدخل واستقبالاً ثلاثياً ومطبخ لا كورنو وفناءً بحديقة شتوية وأربع غرف نوم بحمامات خاصة وصالة خاصة، مع جناح خدمة منفصل. ويُخصص الطابق الأول لجناح رئيسي بحمامين وغرفتي ملابس وستة أجنحة نوم أخرى وصالتين وغرفة إفطار وتراسات تطل على البحر والجبال. وفي الأسفل سبا داخلي بمسبح بطول 15 متراً وجاكوزي وساونا ومرآب لثماني سيارات وأقبية وغرفة آمنة.',
        'في الخارج بحيرة خاصة وملعب تنس ومسبح بطول 25 متراً مع جاكوزي بأبعاد 12 في 5 أمتار وبيت مسبح بغرفة بخار، وفيلا للحارس ومقر أمني. تم البيع؛ نعرضه توثيقاً للمساكن التي مثّلناها.',
      ],
    },
    highlights: {
      en: ['Three-hectare estate above Cannes', '12 bedrooms, 16 bathrooms', 'Indoor spa with 15-metre pool', 'Private lake and tennis court', 'Garage for eight cars', 'Sold'],
      ar: ['ضيعة بمساحة ثلاثة هكتارات فوق كان', '12 غرفة نوم و16 دورة مياه', 'سبا داخلي بمسبح 15 متراً', 'بحيرة خاصة وملعب تنس', 'مرآب لثماني سيارات', 'تم البيع'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'da-vinci-tower-by-pagani-dubai', sourceRef: null, status: 'available', category: 'international', type: 'apartment', featured: false,
    title: { en: 'Da Vinci Tower by Pagani, Dubai', ar: 'برج دا فينشي بتوقيع باجاني، دبي' },
    location: loc({ en: 'Downtown Dubai, Dubai Canal', ar: 'وسط مدينة دبي، قناة دبي' }, { en: 'Dubai', ar: 'دبي' }, { en: 'United Arab Emirates', ar: 'الإمارات العربية المتحدة' }, 'AE'),
    price: { amount: 6800000, currency: 'AED', from: true, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: 19 },
    folder: 'da-vinci-tower-interiors-by-pagani',
    images: [[17, 'tower'], [5, 'rooftop_pool'], [13, 'pool'], [6, 'living'], [15, 'lounge'], [11, 'kitchen'], [14, 'master'], [9, 'gym'], [19, 'aerial']],
    description: {
      en: [
        'Da Vinci Tower is the first residential building with interiors by Pagani. Nineteen storeys rise above the Dubai Canal in Downtown Dubai, moments from Marasi Business Bay, with views of the Burj Khalifa; a suspended sphere, the \'pearl\', sits at the heart of the geometric façade.',
        'Two-, three- and four-bedroom residences range from 77 to 398 square metres, finished with premium leather, Italian marble, kinetic chandeliers, carbon-fibre accents and wood panelling. Smart controls manage security, temperature, lighting, music and appliances.',
        'A rooftop pool overlooks Downtown Dubai, with a gym, separate steam and sauna rooms for men and women, discreet private elevators and 24-hour concierge. Prices start from AED 6,800,000.',
      ],
      ar: [
        'برج دا فينشي أول مبنى سكني بتصاميم داخلية من باجاني. يرتفع تسعة عشر طابقاً فوق قناة دبي في وسط مدينة دبي، على خطوات من مرسى الخليج التجاري، بإطلالات على برج خليفة، وتتوسط واجهته الهندسية كرة معلقة تُعرف بـ«اللؤلؤة».',
        'تتراوح مساحات المساكن من غرفتين وثلاث وأربع غرف نوم بين 77 و398 متراً مربعاً، بتشطيبات من الجلد الفاخر والرخام الإيطالي والثريات الحركية ولمسات ألياف الكربون والكسوة الخشبية. تدير أنظمة ذكية الأمن ودرجة الحرارة والإضاءة والموسيقى والأجهزة.',
        'مسبح على السطح يطل على وسط مدينة دبي، مع نادٍ رياضي وغرف بخار وساونا منفصلة للرجال والنساء ومصاعد خاصة وخدمة كونسيرج على مدار الساعة. تبدأ الأسعار من 6,800,000 درهم إماراتي.',
      ],
    },
    highlights: {
      en: ['First residences with interiors by Pagani', 'Views of the Burj Khalifa and Dubai Canal', '2–4 bedrooms, 77–398 sqm', 'Rooftop pool over Downtown Dubai', '24-hour concierge', 'From AED 6,800,000'],
      ar: ['أولى المساكن بتصاميم داخلية من باجاني', 'إطلالات على برج خليفة وقناة دبي', 'من غرفتين إلى أربع غرف، 77–398 متراً مربعاً', 'مسبح على السطح يطل على وسط دبي', 'كونسيرج على مدار الساعة', 'ابتداءً من 6,800,000 درهم إماراتي'],
    },
    listedAt: '2026-09-05',
  },
  {
    slug: 'painite-villas-by-lamborghini-benahavis', sourceRef: 'VIL-044', status: 'available', category: 'international', type: 'mansion', featured: true,
    title: { en: 'Painite Villas by Lamborghini, Benahavís', ar: 'فلل باينايت بتوقيع لامبورغيني، بيناهابيس' },
    location: loc({ en: 'Benahavís, Costa del Sol', ar: 'بيناهابيس، كوستا ديل سول' }, { en: 'Marbella', ar: 'ماربيا' }, { en: 'Spain', ar: 'إسبانيا' }, 'ES'),
    price: { amount: null, currency: 'EUR', from: false, period: null, onRequest: true },
    specs: { beds: 6, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'painite-villas-by-lamborghini',
    images: [[1, 'render'], [4, 'render'], [3, 'living'], [2, 'aerial'], [5, 'living'], [6, 'car_lift']],
    description: {
      en: [
        'Within Tierra Viva, a gated community in the hills of Benahavís designed in partnership with Automobili Lamborghini, the Painite Villas are the only villas in southern Spain with a private Sky Car Lift. The lift carries a car through a glass dome into the living space, where floor-to-ceiling glazing frames the Mediterranean and the Andalusian hills.',
        'Each villa has six bedrooms, expansive roof terraces, a large swimming pool and landscaped gardens, with panoramic sea views from every level. Four mansion types are offered across the community, from 700 to 1,450 square metres, with private gyms, cinemas and spas.',
        'Residents share a private clubhouse with a Lamborghini Café, spa, gym, pools and lounges. Marbella and Puerto Banús are minutes away, with twelve golf clubs nearby. Completion is scheduled for June 2028. Price on request.',
      ],
      ar: [
        'ضمن تييرا فيفا، المجتمع المسور في تلال بيناهابيس المصمم بالشراكة مع أوتوموبيلي لامبورغيني، فلل باينايت هي الوحيدة في جنوب إسبانيا المزودة بمصعد سيارات خاص. يحمل المصعد السيارة عبر قبة زجاجية إلى داخل مساحة المعيشة، حيث تؤطر الواجهات الزجاجية الممتدة من الأرض إلى السقف البحر الأبيض المتوسط وتلال الأندلس.',
        'لكل فيلا ست غرف نوم وتراسات علوية واسعة ومسبح كبير وحدائق منسقة، مع إطلالات بحرية بانورامية من كل الطوابق. تُعرض أربعة طرز من القصور في المجتمع بمساحات من 700 إلى 1,450 متراً مربعاً، بصالات رياضية وسينما وسبا خاصة.',
        'يتشارك السكان نادياً خاصاً يضم مقهى لامبورغيني وسبا ونادياً رياضياً ومسابح وصالات. ماربيا وبورتو بانوس على دقائق، مع اثني عشر نادي جولف في الجوار. التسليم المتوقع في يونيو 2028. السعر عند الطلب.',
      ],
    },
    highlights: {
      en: ['Private Sky Car Lift by Lamborghini', 'Six bedrooms with panoramic sea views', '700–1,450 sqm mansion types', 'Private clubhouse with Lamborghini Café', 'Minutes from Marbella and Puerto Banús', 'Completion June 2028'],
      ar: ['مصعد سيارات خاص من لامبورغيني', 'ست غرف نوم بإطلالات بحرية بانورامية', 'طرز قصور من 700 إلى 1,450 متراً مربعاً', 'نادٍ خاص بمقهى لامبورغيني', 'على دقائق من ماربيا وبورتو بانوس', 'التسليم في يونيو 2028'],
    },
    listedAt: '2026-04-18',
  },
  {
    slug: 'trump-cliff-villas-aida-muscat', sourceRef: 'VIL-034', status: 'available', category: 'international', type: 'villa', featured: false,
    title: { en: 'Trump Cliff Villas, AIDA, Muscat', ar: 'فلل ترامب كليف، آيدا، مسقط' },
    location: loc({ en: 'AIDA', ar: 'آيدا' }, { en: 'Muscat', ar: 'مسقط' }, { en: 'Oman', ar: 'سلطنة عُمان' }, 'OM'),
    price: { amount: 4000000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: 3, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'trump-golf-villas',
    images: [[6, 'render'], { folder: 'aida', i: 2, room: 'pool' }, [5, 'pool'], [7, 'living'], [8, 'terrace'], [1, 'master'], [2, 'lounge'], [4, 'bar'], { folder: 'aida', i: 9, room: 'golf' }, [0, 'aerial']],
    description: {
      en: [
        'The Trump Cliff Villas sit 130 metres above sea level beside the Trump International Hotel within AIDA, on the coast at Muscat. Each three-bedroom villa is delivered fully furnished with a private pool overlooking the sea, in 128 to 166 square metres.',
        'Managed by Trump, the villas may be lived in or leased. Owners have access to the Trump 18-hole championship golf course, the members-only club, The Cliff night club, AIDA Beach and the wider community\'s plazas, cafés, restaurants, wellness centres and trails.',
        'Completion is scheduled for December 2028, with freehold ownership open to all nationalities. Prices start from SAR 4,000,000.',
      ],
      ar: [
        'تقع فلل ترامب كليف على ارتفاع 130 متراً فوق سطح البحر إلى جانب فندق ترامب الدولي ضمن آيدا على ساحل مسقط. تُسلم كل فيلا من ثلاث غرف نوم مفروشة بالكامل بمسبح خاص يطل على البحر، بمساحة من 128 إلى 166 متراً مربعاً.',
        'تُدار الفلل من قبل ترامب، ويمكن السكن فيها أو تأجيرها. يتمتع الملاك بالوصول إلى ملعب ترامب للجولف بثماني عشرة حفرة والنادي المخصص للأعضاء ونادي ذا كليف الليلي وشاطئ آيدا، إلى جانب ساحات المجتمع ومقاهيه ومطاعمه ومراكز العافية ومساراته.',
        'التسليم المتوقع في ديسمبر 2028، والتملك الحر متاح لجميع الجنسيات. تبدأ الأسعار من 4,000,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['130 metres above the sea', 'Fully furnished with private pool', 'Managed by Trump, live in or lease', '18-hole championship golf course', 'Freehold for all nationalities', 'From SAR 4,000,000'],
      ar: ['على ارتفاع 130 متراً فوق البحر', 'مفروشة بالكامل مع مسبح خاص', 'بإدارة ترامب، للسكن أو التأجير', 'ملعب جولف بثماني عشرة حفرة', 'تملك حر لجميع الجنسيات', 'ابتداءً من 4,000,000 ريال سعودي'],
    },
    listedAt: '2026-03-21',
  },
  // ───────────────────────────── ROUND 2 (2026-09-05) ─────────────────────────────
  // Append only — ids are positional (BONA-033 onwards). Facts come from the TK public API rows
  // (sourceRef = API id; scripts/sync-listings.mjs keeps status/price/tour fresh).
  // Kian Al-Masiah units. Photographs: gallery folder kian-residence = the developer's completed
  // Kayan Residence building in Al Nahda; units in Buildings 113/114/115/117 say so in their copy.
  {
    slug: 'kayan-residence-al-nahda-unit-128a', sourceRef: 'KIA-128A', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Kayan Residence, 136 sqm Apartment, Al Nahda', ar: 'كيان ريزيدنس، شقة 136 م²، النهضة' },
    location: loc(AL_NAHDA),
    price: { amount: 990000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 2, baths: 3, areaSqm: 136, plotSqm: null, yearBuilt: 2024, floors: null },
    project: KAYAN_PROJECT,
    unit: { floor: '1st, 2nd or 3rd', block: '128', unitRef: 'KIA-128A' },
    folder: 'kian-residence',
    images: [[18, 'exterior'], [13, 'facade_night'], [16, 'lobby'], [0, 'living'], [2, 'kitchen'], [5, 'bedroom'], [10, 'cafe'], [1, 'bathroom']],
    description: {
      en: [
        'A four-room apartment of 136 square metres in Kayan Residence, Al Nahda, a short distance from the Jeddah waterfront. The plan holds two bedrooms, three bathrooms, a large living room and a modern kitchen, and each apartment is served by its own private elevator.',
        'The building was completed in 2024 by Kian Al-Masiah and is run on a hotel model: a coffee-shop area, a children\'s play area, a gym, smart access and covered parking, with a smart-home system and central air conditioning in every residence.',
        'Units of this plan are offered on the first, second and third floors at SAR 990,000.',
      ],
      ar: [
        'شقة من أربع غرف بمساحة 136 متراً مربعاً في كيان ريزيدنس بحي النهضة، على مسافة قصيرة من الواجهة البحرية لجدة. يضم المخطط غرفتي نوم وثلاث دورات مياه وصالة واسعة ومطبخاً حديثاً، ويخدم كل شقة مصعد خاص بها.',
        'اكتمل بناء المبنى عام 2024 على يد كيان الماسية، ويُدار بأسلوب فندقي: منطقة مقهى ومنطقة ألعاب للأطفال ونادٍ رياضي ودخول ذكي ومواقف مغطاة، مع نظام منزل ذكي وتكييف مركزي في كل مسكن.',
        'تُعرض وحدات هذا المخطط في الأدوار الأول والثاني والثالث بسعر 990,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['136 sqm, two bedrooms and three bathrooms', 'Private elevator to the apartment', 'Completed 2024', 'Hotel-style building with coffee shop and gym', 'First, second or third floor', 'SAR 990,000'],
      ar: ['136 متراً مربعاً، غرفتا نوم وثلاث دورات مياه', 'مصعد خاص للشقة', 'اكتمل البناء عام 2024', 'مبنى بأسلوب فندقي مع مقهى ونادٍ رياضي', 'الدور الأول أو الثاني أو الثالث', '990,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  {
    slug: 'kayan-residence-al-nahda-unit-127a', sourceRef: 'KIA-127A', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Kayan Residence, 120 sqm Apartment, Al Nahda', ar: 'كيان ريزيدنس، شقة 120 م²، النهضة' },
    location: loc(AL_NAHDA),
    price: { amount: 940000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 2, baths: 3, areaSqm: 120, plotSqm: null, yearBuilt: 2024, floors: null },
    project: KAYAN_PROJECT,
    unit: { floor: '1st or 3rd', block: '127', unitRef: 'KIA-127A' },
    folder: 'kian-residence',
    images: [[13, 'facade_night'], [17, 'exterior'], [16, 'lobby'], [3, 'living'], [4, 'kitchen'], [6, 'bedroom'], [12, 'cafe'], [1, 'bathroom']],
    description: {
      en: [
        'The three-room plan at Kayan Residence, Al Nahda: 120 square metres with two bedrooms, three bathrooms, a living room and a fitted kitchen, served by a private elevator. The building was completed in 2024 by Kian Al-Masiah.',
        'Residents share the hotel-style ground floor with its coffee-shop area and children\'s play area, a gym, smart access and covered parking. Every apartment has a smart-home system and central air conditioning.',
        'Offered on the first and third floors at SAR 940,000.',
      ],
      ar: [
        'مخطط الغرف الثلاث في كيان ريزيدنس بحي النهضة: 120 متراً مربعاً بغرفتي نوم وثلاث دورات مياه وصالة ومطبخ مجهز، ويخدمه مصعد خاص. اكتمل بناء المبنى عام 2024 على يد كيان الماسية.',
        'يتشارك السكان الطابق الأرضي ذا الطابع الفندقي بمنطقة المقهى ومنطقة ألعاب الأطفال، إلى جانب نادٍ رياضي ودخول ذكي ومواقف مغطاة. وفي كل شقة نظام منزل ذكي وتكييف مركزي.',
        'تُعرض في الدورين الأول والثالث بسعر 940,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['120 sqm, two bedrooms and three bathrooms', 'Private elevator to the apartment', 'Completed 2024', 'Coffee shop, gym and children\'s area', 'First or third floor', 'SAR 940,000'],
      ar: ['120 متراً مربعاً، غرفتا نوم وثلاث دورات مياه', 'مصعد خاص للشقة', 'اكتمل البناء عام 2024', 'مقهى ونادٍ رياضي ومنطقة للأطفال', 'الدور الأول أو الثالث', '940,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  {
    slug: 'kian-building-113-unit-a-al-nuzhah', sourceRef: 'KIA-113A', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Three-Bedroom Apartment, Building 113, Al Nuzhah', ar: 'شقة بثلاث غرف نوم، مبنى 113، النزهة' },
    location: loc(AL_NUZHAH),
    price: { amount: 750000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 3, baths: 3, areaSqm: 174, plotSqm: null, yearBuilt: 2024, floors: null },
    project: kianBuilding('113', AL_NUZHAH),
    unit: { floor: null, block: '113', unitRef: 'KIA-113A' },
    folder: 'kian-residence',
    images: [[16, 'lobby'], [17, 'exterior'], [0, 'living'], [2, 'kitchen'], [6, 'bedroom'], [11, 'terrace'], [1, 'bathroom']],
    description: {
      en: [
        'A five-room apartment of 174 square metres in Building 113, Al Nuzhah, on a commercial street with shops and services on the doorstep. Three bedrooms and three bathrooms, completed in 2024 by Kian Al-Masiah.',
        'Asking price SAR 750,000. The photographs show the developer\'s completed Kayan Residence building in Al Nahda and illustrate its standard of finish; a viewing of the unit itself can be arranged.',
      ],
      ar: [
        'شقة من خمس غرف بمساحة 174 متراً مربعاً في مبنى 113 بحي النزهة، على شارع تجاري تتوفر فيه المحال والخدمات على مقربة. ثلاث غرف نوم وثلاث دورات مياه، واكتمل البناء عام 2024 على يد كيان الماسية.',
        'السعر المطلوب 750,000 ريال سعودي. الصور من مبنى كيان ريزيدنس المكتمل للمطور نفسه في حي النهضة وتوضح مستوى التشطيب المعتمد لديه، ويمكن ترتيب معاينة الوحدة نفسها.',
      ],
    },
    highlights: {
      en: ['174 sqm, three bedrooms', 'Three bathrooms', 'Completed 2024', 'Commercial street frontage', 'SAR 750,000'],
      ar: ['174 متراً مربعاً، ثلاث غرف نوم', 'ثلاث دورات مياه', 'اكتمل البناء عام 2024', 'على شارع تجاري', '750,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  {
    slug: 'kian-building-113-unit-b-al-nuzhah', sourceRef: 'KIA-113B', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Three-Bedroom Apartment of 182 sqm, Building 113, Al Nuzhah', ar: 'شقة بثلاث غرف نوم بمساحة 182 م²، مبنى 113، النزهة' },
    location: loc(AL_NUZHAH),
    price: { amount: 790000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 3, baths: 3, areaSqm: 182, plotSqm: null, yearBuilt: 2024, floors: null },
    project: kianBuilding('113', AL_NUZHAH),
    unit: { floor: null, block: '113', unitRef: 'KIA-113B' },
    folder: 'kian-residence',
    images: [[0, 'living'], [18, 'exterior'], [16, 'lobby'], [4, 'kitchen'], [5, 'bedroom'], [11, 'terrace'], [1, 'bathroom']],
    description: {
      en: [
        'The largest plan in Building 113, Al Nuzhah: 182 square metres over five rooms, with three bedrooms and three bathrooms, on a commercial street close to everyday shops and services. Completed in 2024 by Kian Al-Masiah.',
        'Asking price SAR 790,000. The photographs show the developer\'s completed Kayan Residence building in Al Nahda and illustrate its standard of finish; a viewing of the unit itself can be arranged.',
      ],
      ar: [
        'أكبر مخططات مبنى 113 بحي النزهة: 182 متراً مربعاً موزعة على خمس غرف، منها ثلاث غرف نوم وثلاث دورات مياه، على شارع تجاري قريب من المحال والخدمات اليومية. اكتمل البناء عام 2024 على يد كيان الماسية.',
        'السعر المطلوب 790,000 ريال سعودي. الصور من مبنى كيان ريزيدنس المكتمل للمطور نفسه في حي النهضة وتوضح مستوى التشطيب المعتمد لديه، ويمكن ترتيب معاينة الوحدة نفسها.',
      ],
    },
    highlights: {
      en: ['182 sqm, the largest plan in the building', 'Three bedrooms, three bathrooms', 'Completed 2024', 'Commercial street frontage', 'SAR 790,000'],
      ar: ['182 متراً مربعاً، أكبر مخططات المبنى', 'ثلاث غرف نوم وثلاث دورات مياه', 'اكتمل البناء عام 2024', 'على شارع تجاري', '790,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  {
    slug: 'kian-building-113-unit-c-al-nuzhah', sourceRef: 'KIA-113C', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Corner Three-Bedroom Apartment, Building 113, Al Nuzhah', ar: 'شقة زاوية بثلاث غرف نوم، مبنى 113، النزهة' },
    location: loc(AL_NUZHAH),
    price: { amount: 760000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 3, baths: 3, areaSqm: 174, plotSqm: null, yearBuilt: 2024, floors: null },
    project: kianBuilding('113', AL_NUZHAH),
    unit: { floor: null, block: '113', unitRef: 'KIA-113C' },
    folder: 'kian-residence',
    images: [[10, 'cafe'], [17, 'exterior'], [16, 'lobby'], [0, 'living'], [2, 'kitchen'], [6, 'bedroom'], [1, 'bathroom']],
    description: {
      en: [
        'A corner apartment of 174 square metres in Building 113, Al Nuzhah, with frontage on two streets and daylight from two sides. Five rooms in all: three bedrooms, three bathrooms and the living spaces. Completed in 2024 by Kian Al-Masiah.',
        'Asking price SAR 760,000. The photographs show the developer\'s completed Kayan Residence building in Al Nahda and illustrate its standard of finish; a viewing of the unit itself can be arranged.',
      ],
      ar: [
        'شقة زاوية بمساحة 174 متراً مربعاً في مبنى 113 بحي النزهة، بواجهتين على شارعين وإضاءة طبيعية من جهتين. خمس غرف في المجموع: ثلاث غرف نوم وثلاث دورات مياه ومساحات المعيشة. اكتمل البناء عام 2024 على يد كيان الماسية.',
        'السعر المطلوب 760,000 ريال سعودي. الصور من مبنى كيان ريزيدنس المكتمل للمطور نفسه في حي النهضة وتوضح مستوى التشطيب المعتمد لديه، ويمكن ترتيب معاينة الوحدة نفسها.',
      ],
    },
    highlights: {
      en: ['Corner unit on two streets', '174 sqm, three bedrooms', 'Three bathrooms', 'Completed 2024', 'SAR 760,000'],
      ar: ['وحدة زاوية على شارعين', '174 متراً مربعاً، ثلاث غرف نوم', 'ثلاث دورات مياه', 'اكتمل البناء عام 2024', '760,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  {
    slug: 'kian-building-114-unit-b-al-nuzhah', sourceRef: 'KIA-114B', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Rear Three-Bedroom Apartment, Building 114, Al Nuzhah', ar: 'شقة خلفية بثلاث غرف نوم، مبنى 114، النزهة' },
    location: loc(AL_NUZHAH),
    price: { amount: 660000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 3, baths: 3, areaSqm: 169, plotSqm: null, yearBuilt: 2024, floors: null },
    project: kianBuilding('114', AL_NUZHAH),
    unit: { floor: null, block: '114', unitRef: 'KIA-114B' },
    folder: 'kian-residence',
    images: [[11, 'terrace'], [18, 'exterior'], [16, 'lobby'], [3, 'living'], [2, 'kitchen'], [8, 'bedroom'], [1, 'bathroom']],
    description: {
      en: [
        'A five-room apartment of 169 square metres at the rear of Building 114, Al Nuzhah, set back from the commercial street the building fronts, so the bedrooms sit on the quieter side. Three bedrooms and three bathrooms, completed in 2024 by Kian Al-Masiah.',
        'Asking price SAR 660,000. The photographs show the developer\'s completed Kayan Residence building in Al Nahda and illustrate its standard of finish; a viewing of the unit itself can be arranged.',
      ],
      ar: [
        'شقة من خمس غرف بمساحة 169 متراً مربعاً في الجهة الخلفية من مبنى 114 بحي النزهة، بعيداً عن الشارع التجاري الذي يطل عليه المبنى، فتقع غرف النوم على الجانب الأهدأ. ثلاث غرف نوم وثلاث دورات مياه، واكتمل البناء عام 2024 على يد كيان الماسية.',
        'السعر المطلوب 660,000 ريال سعودي. الصور من مبنى كيان ريزيدنس المكتمل للمطور نفسه في حي النهضة وتوضح مستوى التشطيب المعتمد لديه، ويمكن ترتيب معاينة الوحدة نفسها.',
      ],
    },
    highlights: {
      en: ['169 sqm, three bedrooms', 'Rear unit on the quieter side', 'Three bathrooms', 'Completed 2024', 'SAR 660,000'],
      ar: ['169 متراً مربعاً، ثلاث غرف نوم', 'وحدة خلفية على الجانب الأهدأ', 'ثلاث دورات مياه', 'اكتمل البناء عام 2024', '660,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  {
    slug: 'kian-building-114-unit-c-al-nuzhah', sourceRef: 'KIA-114C', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Fourth-Floor Two-Bedroom Apartment, Building 114, Al Nuzhah', ar: 'شقة بغرفتي نوم في الدور الرابع، مبنى 114، النزهة' },
    location: loc(AL_NUZHAH),
    price: { amount: 595000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 2, baths: 3, areaSqm: 151, plotSqm: null, yearBuilt: 2024, floors: null },
    project: kianBuilding('114', AL_NUZHAH),
    unit: { floor: '4th', block: '114', unitRef: 'KIA-114C' },
    folder: 'kian-residence',
    images: [[14, 'gym'], [17, 'exterior'], [16, 'lobby'], [0, 'living'], [4, 'kitchen'], [8, 'bedroom'], [1, 'bathroom']],
    description: {
      en: [
        'A four-room apartment of 151 square metres on the fourth floor of Building 114, Al Nuzhah, facing the commercial street. Two bedrooms and three bathrooms, completed in 2024 by Kian Al-Masiah.',
        'Asking price SAR 595,000. The photographs show the developer\'s completed Kayan Residence building in Al Nahda and illustrate its standard of finish; a viewing of the unit itself can be arranged.',
      ],
      ar: [
        'شقة من أربع غرف بمساحة 151 متراً مربعاً في الدور الرابع من مبنى 114 بحي النزهة، تطل على الشارع التجاري. غرفتا نوم وثلاث دورات مياه، واكتمل البناء عام 2024 على يد كيان الماسية.',
        'السعر المطلوب 595,000 ريال سعودي. الصور من مبنى كيان ريزيدنس المكتمل للمطور نفسه في حي النهضة وتوضح مستوى التشطيب المعتمد لديه، ويمكن ترتيب معاينة الوحدة نفسها.',
      ],
    },
    highlights: {
      en: ['151 sqm, two bedrooms', 'Fourth floor', 'Three bathrooms', 'Completed 2024', 'SAR 595,000'],
      ar: ['151 متراً مربعاً، غرفتا نوم', 'الدور الرابع', 'ثلاث دورات مياه', 'اكتمل البناء عام 2024', '595,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  {
    slug: 'kian-building-117-unit-b-al-nuzhah', sourceRef: 'KIA-117B', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Rear Three-Bedroom Apartment, Building 117, Al Nuzhah', ar: 'شقة خلفية بثلاث غرف نوم، مبنى 117، النزهة' },
    location: loc(AL_NUZHAH),
    price: { amount: 660000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 3, baths: 3, areaSqm: 169, plotSqm: null, yearBuilt: 2024, floors: null },
    project: kianBuilding('117', AL_NUZHAH),
    unit: { floor: null, block: '117', unitRef: 'KIA-117B' },
    folder: 'kian-residence',
    images: [[12, 'cafe'], [18, 'exterior'], [16, 'lobby'], [3, 'living'], [2, 'kitchen'], [5, 'bedroom'], [11, 'terrace'], [1, 'bathroom']],
    description: {
      en: [
        'A five-room apartment of 169 square metres at the rear of Building 117, Al Nuzhah, away from the commercial street on which the building stands. Three bedrooms and three bathrooms, completed in 2024 by Kian Al-Masiah.',
        'Asking price SAR 660,000. The photographs show the developer\'s completed Kayan Residence building in Al Nahda and illustrate its standard of finish; a viewing of the unit itself can be arranged.',
      ],
      ar: [
        'شقة من خمس غرف بمساحة 169 متراً مربعاً في الجهة الخلفية من مبنى 117 بحي النزهة، بعيداً عن الشارع التجاري الذي يقوم عليه المبنى. ثلاث غرف نوم وثلاث دورات مياه، واكتمل البناء عام 2024 على يد كيان الماسية.',
        'السعر المطلوب 660,000 ريال سعودي. الصور من مبنى كيان ريزيدنس المكتمل للمطور نفسه في حي النهضة وتوضح مستوى التشطيب المعتمد لديه، ويمكن ترتيب معاينة الوحدة نفسها.',
      ],
    },
    highlights: {
      en: ['169 sqm, three bedrooms', 'Rear unit away from the street', 'Three bathrooms', 'Completed 2024', 'SAR 660,000'],
      ar: ['169 متراً مربعاً، ثلاث غرف نوم', 'وحدة خلفية بعيداً عن الشارع', 'ثلاث دورات مياه', 'اكتمل البناء عام 2024', '660,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  {
    slug: 'kian-building-117-unit-c-al-nuzhah', sourceRef: 'KIA-117C', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Two-Bedroom Apartment, Building 117, Al Nuzhah', ar: 'شقة بغرفتي نوم، مبنى 117، النزهة' },
    location: loc(AL_NUZHAH),
    price: { amount: 595000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 2, baths: 3, areaSqm: 151, plotSqm: null, yearBuilt: 2024, floors: null },
    project: kianBuilding('117', AL_NUZHAH),
    unit: { floor: null, block: '117', unitRef: 'KIA-117C' },
    folder: 'kian-residence',
    images: [[7, 'view'], [17, 'exterior'], [16, 'lobby'], [0, 'living'], [4, 'kitchen'], [6, 'bedroom'], [10, 'cafe']],
    description: {
      en: [
        'A four-room apartment of 151 square metres in Building 117, Al Nuzhah, facing the commercial street. Two bedrooms and three bathrooms, completed in 2024 by Kian Al-Masiah.',
        'Asking price SAR 595,000. The photographs show the developer\'s completed Kayan Residence building in Al Nahda and illustrate its standard of finish; a viewing of the unit itself can be arranged.',
      ],
      ar: [
        'شقة من أربع غرف بمساحة 151 متراً مربعاً في مبنى 117 بحي النزهة، تطل على الشارع التجاري. غرفتا نوم وثلاث دورات مياه، واكتمل البناء عام 2024 على يد كيان الماسية.',
        'السعر المطلوب 595,000 ريال سعودي. الصور من مبنى كيان ريزيدنس المكتمل للمطور نفسه في حي النهضة وتوضح مستوى التشطيب المعتمد لديه، ويمكن ترتيب معاينة الوحدة نفسها.',
      ],
    },
    highlights: {
      en: ['151 sqm, two bedrooms', 'Three bathrooms', 'Completed 2024', 'Commercial street frontage', 'SAR 595,000'],
      ar: ['151 متراً مربعاً، غرفتا نوم', 'ثلاث دورات مياه', 'اكتمل البناء عام 2024', 'على شارع تجاري', '595,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  {
    slug: 'kian-building-115-unit-a-al-rayyan', sourceRef: 'KIA-115A', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Front-Facing Two-Bedroom Apartment, Building 115, Al Rayyan', ar: 'شقة أمامية بغرفتي نوم، مبنى 115، الريان' },
    location: loc(AL_RAYYAN),
    price: { amount: 550000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: 2, baths: 3, areaSqm: 140, plotSqm: null, yearBuilt: 2023, floors: null },
    project: kianBuilding('115', AL_RAYYAN),
    unit: { floor: null, block: '115', unitRef: 'KIA-115A' },
    folder: 'kian-residence',
    images: [[9, 'entrance'], [18, 'exterior'], [16, 'lobby'], [3, 'living'], [2, 'kitchen'], [5, 'bedroom'], [14, 'gym']],
    description: {
      en: [
        'A four-room apartment of 140 square metres on the front of Building 115 in Al Rayyan, with the main façade and its windows to the street. Two bedrooms and three bathrooms, completed in 2023 by Kian Al-Masiah.',
        'Asking price SAR 550,000, the most accessible entry to the developer\'s portfolio. The photographs show the developer\'s completed Kayan Residence building in Al Nahda and illustrate its standard of finish; a viewing of the unit itself can be arranged.',
      ],
      ar: [
        'شقة من أربع غرف بمساحة 140 متراً مربعاً في الواجهة الأمامية لمبنى 115 بحي الريان، بنوافذها المطلة على الشارع. غرفتا نوم وثلاث دورات مياه، واكتمل البناء عام 2023 على يد كيان الماسية.',
        'السعر المطلوب 550,000 ريال سعودي، وهو المدخل الأيسر إلى مشاريع المطور. الصور من مبنى كيان ريزيدنس المكتمل للمطور نفسه في حي النهضة وتوضح مستوى التشطيب المعتمد لديه، ويمكن ترتيب معاينة الوحدة نفسها.',
      ],
    },
    highlights: {
      en: ['140 sqm, two bedrooms', 'Front-facing unit', 'Three bathrooms', 'Completed 2023', 'SAR 550,000'],
      ar: ['140 متراً مربعاً، غرفتا نوم', 'وحدة أمامية', 'ثلاث دورات مياه', 'اكتمل البناء عام 2023', '550,000 ريال سعودي'],
    },
    listedAt: '2026-09-01',
  },
  // Further API listings with enough photographs in the gallery.
  {
    slug: 'dari-q-al-salamah', sourceRef: 'APT-021', status: 'available', category: 'buy', type: 'apartment', featured: false,
    title: { en: 'Dari Q Apartments, Al Salamah', ar: 'شقق داري كيو، السلامة' },
    location: loc({ en: 'Al Salamah', ar: 'السلامة' }),
    price: { amount: 1200000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: 3, baths: 3, areaSqm: 160.5, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'dari-q-luxury-apartment',
    images: [[6, 'rooftop_pool'], [15, 'exterior'], [12, 'lobby'], [20, 'living'], [17, 'kitchen'], [24, 'living'], [27, 'bathroom'], [8, 'gym'], [34, 'courtyard'], [39, 'aerial']],
    description: {
      en: [
        'Dari Q is a completed apartment building in Al Salamah, north Jeddah, with a Starbucks at street level and a landscaped courtyard at its centre. The three-bedroom apartments measure 160.5 square metres with three bathrooms, and are offered from SAR 1,200,000.',
        'Residents have a rooftop pool, a fully equipped gym, a basketball court and shaded seating in the courtyard, with dedicated parking, a basement, a driver\'s room and 24-hour security.',
      ],
      ar: [
        'داري كيو مبنى سكني مكتمل في حي السلامة شمال جدة، يضم فرعاً لستاربكس في الطابق الأرضي وفناءً منسقاً في قلبه. تبلغ مساحة الشقق ذات الغرف الثلاث 160.5 متراً مربعاً مع ثلاث دورات مياه، وتُعرض ابتداءً من 1,200,000 ريال سعودي.',
        'يتوفر للسكان مسبح على السطح ونادٍ رياضي مجهز بالكامل وملعب كرة سلة وجلسات مظللة في الفناء، مع مواقف مخصصة وقبو وغرفة للسائق وحراسة على مدار الساعة.',
      ],
    },
    highlights: {
      en: ['160.5 sqm, three bedrooms and three bathrooms', 'Rooftop pool and gym', 'Landscaped courtyard and basketball court', 'Dedicated parking, basement and driver\'s room', '24-hour security', 'From SAR 1,200,000'],
      ar: ['160.5 متراً مربعاً، ثلاث غرف نوم وثلاث دورات مياه', 'مسبح على السطح ونادٍ رياضي', 'فناء منسق وملعب كرة سلة', 'مواقف مخصصة وقبو وغرفة للسائق', 'حراسة على مدار الساعة', 'ابتداءً من 1,200,000 ريال سعودي'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'neptune-villas-north-riyadh', sourceRef: 'VIL-029', status: 'available', category: 'off-plan', type: 'villa', featured: false,
    title: { en: 'Neptune Villas, Interiors by Mouawad, North Riyadh', ar: 'فلل نبتون بتصميم داخلي من معوض، شمال الرياض' },
    location: loc({ en: 'North Riyadh', ar: 'شمال الرياض' }, { en: 'Riyadh', ar: 'الرياض' }),
    price: { amount: 4600000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: 5, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'neptune-interiors-by-mouawad',
    images: [[2, 'exterior'], [3, 'terrace'], [0, 'render'], [1, 'aerial']],
    description: {
      en: [
        'Neptune Villas is a villa community under construction in north Riyadh, with interiors by the jeweller Mouawad. Each villa has five bedrooms, in sizes from 300 to 420 square metres; the renders show roof terraces and covered parking.',
        'The masterplan sets the houses along tree-lined streets around a central park and pool. Prices start from SAR 4,600,000.',
      ],
      ar: [
        'فلل نبتون مشروع فلل قيد الإنشاء في شمال الرياض، بتصميم داخلي من دار معوض للمجوهرات. تضم كل فيلا خمس غرف نوم بمساحات من 300 إلى 420 متراً مربعاً، وتُظهر التصاميم تراسات علوية ومواقف مغطاة.',
        'يوزع المخطط العام المنازل على شوارع تظللها الأشجار حول حديقة مركزية ومسبح. تبدأ الأسعار من 4,600,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['Interiors by Mouawad', 'Five bedrooms', '300 to 420 sqm', 'Under construction in north Riyadh', 'From SAR 4,600,000'],
      ar: ['تصميم داخلي من معوض', 'خمس غرف نوم', 'من 300 إلى 420 متراً مربعاً', 'قيد الإنشاء في شمال الرياض', 'ابتداءً من 4,600,000 ريال سعودي'],
    },
    listedAt: '2026-03-21',
  },
  {
    slug: 'trump-international-hotel-residences-aida-muscat', sourceRef: 'APT-035', status: 'available', category: 'international', type: 'apartment', featured: true,
    title: { en: 'Trump International Hotel Residences, AIDA, Muscat', ar: 'مساكن فندق ترامب الدولي، آيدا، مسقط' },
    location: loc({ en: 'AIDA', ar: 'آيدا' }, { en: 'Muscat', ar: 'مسقط' }, { en: 'Oman', ar: 'سلطنة عُمان' }, 'OM'),
    price: { amount: 1700000, currency: 'SAR', from: true, period: null, onRequest: false },
    specs: { beds: 1, baths: null, areaSqm: null, plotSqm: null, yearBuilt: null, floors: null },
    folder: 'trump-international-hotel-oman',
    images: [[0, 'pool'], [13, 'pool_night'], [8, 'lobby'], [6, 'living'], [7, 'master'], [5, 'event_hall'], [1, 'lounge'], [4, 'terrace'], [3, 'bathroom'], [11, 'aerial']],
    description: {
      en: [
        'Serviced residences within the Trump International Hotel at AIDA, on the cliffs above the sea at Muscat. Apartments range from 43 to 138 square metres with one to three bedrooms, delivered fully furnished.',
        'Owners use the hotel\'s pool, gym, lounges and restaurants, within the wider AIDA community with its golf course and beach. Prices start from SAR 1,700,000.',
      ],
      ar: [
        'مساكن فندقية ضمن فندق ترامب الدولي في آيدا، على المرتفعات المطلة على البحر في مسقط. تتراوح مساحات الشقق بين 43 و138 متراً مربعاً، بغرفة نوم واحدة إلى ثلاث غرف، وتُسلم مفروشة بالكامل.',
        'يستفيد الملاك من مسبح الفندق وناديه الرياضي وصالاته ومطاعمه، ضمن مجتمع آيدا الأوسع بملعب الجولف والشاطئ. تبدأ الأسعار من 1,700,000 ريال سعودي.',
      ],
    },
    highlights: {
      en: ['Within the Trump International Hotel, AIDA', 'One to three bedrooms, 43 to 138 sqm', 'Fully furnished', 'Hotel pool, gym and restaurants', 'From SAR 1,700,000'],
      ar: ['ضمن فندق ترامب الدولي في آيدا', 'من غرفة إلى ثلاث غرف نوم، 43 إلى 138 متراً مربعاً', 'مفروشة بالكامل', 'مسبح الفندق وناديه الرياضي ومطاعمه', 'ابتداءً من 1,700,000 ريال سعودي'],
    },
    listedAt: '2026-03-21',
  },
  // Land — only plots with an exact pin (Google Maps links in the API descriptions). Stills: scripts/curate/land-stills.mjs.
  {
    slug: 'plot-285-al-shati', sourceRef: 'LND-006', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Residential Plot 285, Al Shati', ar: 'قطعة أرض رقم 285، الشاطئ' },
    location: loc({ en: 'Al Shati', ar: 'الشاطئ' }),
    price: { amount: 3816000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 636, yearBuilt: null, floors: null },
    map: { lat: 21.6011128, lng: 39.1195974 },
    images: [{ local: '/land/LND-006.jpg', room: 'satellite' }, { local: '/land/LND-006-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'Plot 285 in Al Shati, moments from King Road and a few minutes from the Corniche. The plot measures 636 square metres with a north-facing frontage of 21.25 metres on a 16-metre street.',
        'Offered directly by the owner at SAR 6,000 per square metre net, a total of SAR 3,816,000. The satellite frames show the plot\'s position and its surroundings.',
      ],
      ar: [
        'القطعة رقم 285 في حي الشاطئ، على مقربة من طريق الملك ودقائق من الكورنيش. تبلغ مساحتها 636 متراً مربعاً بواجهة شمالية بطول 21.25 متراً على شارع بعرض 16 متراً.',
        'تُعرض من المالك مباشرة بسعر 6,000 ريال للمتر المربع صافياً، بإجمالي 3,816,000 ريال سعودي. توضح الصور الجوية موقع القطعة ومحيطها.',
      ],
    },
    highlights: {
      en: ['636 sqm', 'North-facing, 21.25 m frontage', '16-metre street', 'SAR 6,000 per sqm net', 'Direct from the owner'],
      ar: ['636 متراً مربعاً', 'واجهة شمالية بطول 21.25 متراً', 'شارع بعرض 16 متراً', '6,000 ريال للمتر صافياً', 'من المالك مباشرة'],
    },
    listedAt: '2026-04-10',
  },
  {
    slug: 'corner-plot-al-shati', sourceRef: 'LND-004', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Corner Plot, Al Shati', ar: 'أرض زاوية، الشاطئ' },
    location: loc({ en: 'Al Shati', ar: 'الشاطئ' }),
    price: { amount: 4200000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 625, yearBuilt: null, floors: null },
    map: { lat: 21.613996, lng: 39.1172 },
    images: [{ local: '/land/LND-004.jpg', room: 'satellite' }, { local: '/land/LND-004-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A corner plot of 625 square metres in Al Shati, on two 12-metre streets to the north and east, measuring 24 metres wide by 26 metres deep. It sits on the second block from King Road, north of Heraa Street, close to the district\'s commercial centres and the Jeddah waterfront.',
        'Asking price SAR 4,200,000, about SAR 6,720 per square metre. The satellite frames show the plot\'s position and its surroundings.',
      ],
      ar: [
        'أرض زاوية بمساحة 625 متراً مربعاً في حي الشاطئ، على شارعين بعرض 12 متراً من الجهتين الشمالية والشرقية، بأبعاد 24 متراً عرضاً و26 متراً عمقاً. تقع في المربع الثاني من طريق الملك شمال شارع حراء، على مقربة من المراكز التجارية والواجهة البحرية لجدة.',
        'السعر المطلوب 4,200,000 ريال سعودي، أي نحو 6,720 ريالاً للمتر المربع. توضح الصور الجوية موقع القطعة ومحيطها.',
      ],
    },
    highlights: {
      en: ['625 sqm corner plot', 'Two 12-metre streets, north and east', '24 m by 26 m', 'Second block from King Road', 'Near the Jeddah waterfront', 'SAR 4,200,000'],
      ar: ['أرض زاوية بمساحة 625 متراً مربعاً', 'شارعان بعرض 12 متراً شمالاً وشرقاً', '24 في 26 متراً', 'المربع الثاني من طريق الملك', 'قرب الواجهة البحرية لجدة', '4,200,000 ريال سعودي'],
    },
    listedAt: '2026-04-09',
  },
  // Round 3 (2026-09-05): every available plot in TK's live list with an exact pin. Pins come from the saved land-register
  // source page (C:\Users\ASUS\TK-LAND-REGISTER-source-2026-08-25.html, `const PROPS` lat/lng — the same values the register
  // imported into properties.amenities.land). LND-016, LND-019 and LND-021 have no pin there (empty lat/lng) and are left out.
  {
    slug: 'four-deed-land-king-abdulaziz-road', sourceRef: 'LND-007', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Four-Deed Land, King Abdulaziz Road', ar: 'أرض بأربعة صكوك، طريق الملك عبدالعزيز' },
    location: loc({ en: 'King Abdulaziz Road', ar: 'طريق الملك عبدالعزيز' }),
    price: { amount: 198000000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 12000, yearBuilt: null, floors: null },
    map: { lat: 21.676273027428692, lng: 39.10955018232159 },
    images: [{ local: '/land/LND-007.jpg', room: 'satellite' }, { local: '/land/LND-007-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'Twelve thousand square metres on King Abdulaziz Road, held as four separate deeds of 3,000 square metres each. The land presents a 50-metre frontage to the road with a depth of 60 metres.',
        'Offered below market at SAR 198,000,000, which is SAR 16,500 per square metre. The four deeds can be taken together or considered separately. The satellite frames show the position of the land and its surroundings.',
      ],
      ar: [
        'اثنا عشر ألف متر مربع على طريق الملك عبدالعزيز، مقسّمة إلى أربعة صكوك منفصلة بمساحة 3,000 متر مربع لكل منها. تطل الأرض على الطريق بواجهة بطول 50 متراً وبعمق 60 متراً.',
        'تُعرض بسعر أقل من السوق بقيمة 198,000,000 ريال سعودي، أي 16,500 ريال للمتر المربع. يمكن شراء الصكوك الأربعة معاً أو النظر في كل صك على حدة. توضح الصور الجوية موقع الأرض ومحيطها.',
      ],
    },
    highlights: {
      en: ['12,000 sqm in total', 'Four separate deeds of 3,000 sqm', '50 m frontage on King Abdulaziz Road', '60 m depth', 'SAR 16,500 per sqm', 'Offered below market'],
      ar: ['12,000 متر مربع إجمالاً', 'أربعة صكوك منفصلة بمساحة 3,000 متر مربع', 'واجهة 50 متراً على طريق الملك عبدالعزيز', 'عمق 60 متراً', '16,500 ريال للمتر المربع', 'بسعر أقل من السوق'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'three-street-plot-al-shati-2', sourceRef: 'LND-008', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Three-Street Plot, Al Shati 2', ar: 'أرض على ثلاثة شوارع، الشاطئ 2' },
    location: loc({ en: 'Al Shati 2', ar: 'الشاطئ 2' }),
    price: { amount: 145314000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 24219, yearBuilt: null, floors: null },
    map: { lat: 21.58758602662076, lng: 39.120119218923584 },
    images: [{ local: '/land/LND-008.jpg', room: 'satellite' }, { local: '/land/LND-008-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A plot of 24,219 square metres in Al Shati 2, bounded by three 32-metre streets to the east, north and south. The scale and the three open frontages suit a single large scheme.',
        'The asking price is SAR 145,314,000, calculated at SAR 6,000 per square metre. The satellite frames show the plot and the surrounding district.',
      ],
      ar: [
        'قطعة أرض بمساحة 24,219 متراً مربعاً في حي الشاطئ 2، تحدّها ثلاثة شوارع بعرض 32 متراً من الجهات الشرقية والشمالية والجنوبية. تناسب مساحتها وواجهاتها الثلاث المفتوحة مشروعاً واحداً كبيراً.',
        'السعر المطلوب 145,314,000 ريال سعودي، محسوباً على أساس 6,000 ريال للمتر المربع. توضح الصور الجوية القطعة والحي المحيط بها.',
      ],
    },
    highlights: {
      en: ['24,219 sqm', 'Three frontages: east, north and south', 'Each street 32 m wide', 'SAR 6,000 per sqm', 'Al Shati 2'],
      ar: ['24,219 متراً مربعاً', 'ثلاث واجهات: شرقية وشمالية وجنوبية', 'عرض كل شارع 32 متراً', '6,000 ريال للمتر المربع', 'حي الشاطئ 2'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'development-land-north-abhur-jeddah-tower', sourceRef: 'LND-010', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Development Land north of Jeddah Tower, North Abhur', ar: 'أرض تطوير شمال برج جدة، أبحر الشمالية' },
    location: loc({ en: 'North Abhur', ar: 'أبحر الشمالية' }),
    price: { amount: 100937500, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 11875.69, yearBuilt: null, floors: null },
    map: { lat: 21.7373889, lng: 39.0723056 },
    images: [{ local: '/land/LND-010.jpg', room: 'satellite' }, { local: '/land/LND-010-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A block of 11,875.69 square metres on Prince Abdullah Al-Faisal Street in North Abhur, just north of Jeddah Tower. The land is open on four sides: a 15-metre street to the north, the 52-metre Prince Mishal Street to the south, a 32-metre street to the east and the 52-metre Prince Abdullah Al-Faisal Street to the west.',
        'The asking price is SAR 100,937,500, at SAR 8,500 per square metre. The satellite frames show the block and its position on the two principal streets.',
      ],
      ar: [
        'قطعة بمساحة 11,875.69 متراً مربعاً على شارع الأمير عبدالله الفيصل في أبحر الشمالية، شمال برج جدة مباشرة. الأرض مفتوحة من جهاتها الأربع: شارع بعرض 15 متراً شمالاً، وشارع الأمير مشعل بعرض 52 متراً جنوباً، وشارع بعرض 32 متراً شرقاً، وشارع الأمير عبدالله الفيصل بعرض 52 متراً غرباً.',
        'السعر المطلوب 100,937,500 ريال سعودي، بواقع 8,500 ريال للمتر المربع. توضح الصور الجوية القطعة وموقعها على الشارعين الرئيسيين.',
      ],
    },
    highlights: {
      en: ['11,875.69 sqm', 'Four street frontages', 'Prince Abdullah Al-Faisal Street, 52 m', 'Prince Mishal Street, 52 m', 'Just north of Jeddah Tower', 'SAR 8,500 per sqm'],
      ar: ['11,875.69 متراً مربعاً', 'أربع واجهات على الشوارع', 'شارع الأمير عبدالله الفيصل بعرض 52 متراً', 'شارع الأمير مشعل بعرض 52 متراً', 'شمال برج جدة مباشرة', '8,500 ريال للمتر المربع'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'corniche-road-waterfront-land', sourceRef: 'LND-011', status: 'available', category: 'buy', type: 'land', featured: true,
    title: { en: 'Waterfront Land on Corniche Road', ar: 'أرض على الواجهة البحرية، طريق الكورنيش' },
    location: loc({ en: 'Jeddah Corniche', ar: 'كورنيش جدة' }),
    price: { amount: 578784000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 36174, yearBuilt: null, floors: null },
    map: { lat: 21.61218999611435, lng: 39.10883716393323 },
    images: [{ local: '/land/LND-011.jpg', room: 'satellite' }, { local: '/land/LND-011-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A site of 36,174 square metres with a long frontage on Corniche Road and direct exposure to the Jeddah waterfront. Zoned for commercial and residential use, it is one of the largest single holdings offered on the Corniche.',
        'The asking price is SAR 578,784,000, calculated at SAR 16,000 per square metre. The satellite frames show the site between the road and the shore.',
      ],
      ar: [
        'موقع بمساحة 36,174 متراً مربعاً بواجهة طويلة على طريق الكورنيش وإطلالة مباشرة على الواجهة البحرية لجدة. مخصص للاستخدام التجاري والسكني، وهو من أكبر المواقع المفردة المعروضة على الكورنيش.',
        'السعر المطلوب 578,784,000 ريال سعودي، محسوباً على أساس 16,000 ريال للمتر المربع. توضح الصور الجوية الموقع بين الطريق والشاطئ.',
      ],
    },
    highlights: {
      en: ['36,174 sqm', 'Frontage on Corniche Road', 'Direct waterfront exposure', 'Commercial and residential use', 'SAR 16,000 per sqm'],
      ar: ['36,174 متراً مربعاً', 'واجهة على طريق الكورنيش', 'إطلالة مباشرة على الواجهة البحرية', 'استخدام تجاري وسكني', '16,000 ريال للمتر المربع'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'corniche-plot-four-streets', sourceRef: 'LND-012', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Corniche Plot on Four Streets', ar: 'أرض على الكورنيش بأربعة شوارع' },
    location: loc({ en: 'Jeddah Corniche', ar: 'كورنيش جدة' }),
    price: { amount: 123737500, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 9899, yearBuilt: null, floors: null },
    map: { lat: 21.56158454023218, lng: 39.1116602857581 },
    images: [{ local: '/land/LND-012.jpg', room: 'satellite' }, { local: '/land/LND-012-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A Corniche-side plot of 9,899 square metres, open on four streets and directly exposed to the Jeddah waterfront. It is zoned for commercial and residential use.',
        'The asking price is SAR 123,737,500, calculated at SAR 12,500 per square metre. The satellite frames show the plot and its four street boundaries.',
      ],
      ar: [
        'قطعة أرض بجانب الكورنيش بمساحة 9,899 متراً مربعاً، مفتوحة على أربعة شوارع وبإطلالة مباشرة على الواجهة البحرية لجدة. مخصصة للاستخدام التجاري والسكني.',
        'السعر المطلوب 123,737,500 ريال سعودي، محسوباً على أساس 12,500 ريال للمتر المربع. توضح الصور الجوية القطعة وحدودها على الشوارع الأربعة.',
      ],
    },
    highlights: {
      en: ['9,899 sqm', 'Open on four streets', 'Beside the Corniche', 'Commercial and residential use', 'SAR 12,500 per sqm'],
      ar: ['9,899 متراً مربعاً', 'مفتوحة على أربعة شوارع', 'بجانب الكورنيش', 'استخدام تجاري وسكني', '12,500 ريال للمتر المربع'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'commercial-residential-land-abdullah-al-faisal-road', sourceRef: 'LND-013', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Commercial-Residential Land on Abdullah Al Faisal Road', ar: 'أرض تجارية سكنية على طريق عبدالله الفيصل' },
    location: loc({ en: 'North Abhur', ar: 'أبحر الشمالية' }),
    price: { amount: 50000000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 8800, yearBuilt: null, floors: null },
    map: { lat: 21.768665307588044, lng: 39.13062949365097 },
    images: [{ local: '/land/LND-013.jpg', room: 'satellite' }, { local: '/land/LND-013-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A plot of 8,800 square metres directly on Abdullah Al Faisal Road in North Abhur, permitted for commercial use and residential villas. It has four frontages: 60 metres on a 52-metre road, 148 metres on a 36-metre road, 148 metres on a 20-metre road and 60 metres on a 15-metre road.',
        'The net asking price is SAR 50,000,000, about SAR 5,680 per square metre. The satellite frames show the plot and its position on the road.',
      ],
      ar: [
        'قطعة أرض بمساحة 8,800 متر مربع على طريق عبدالله الفيصل مباشرة في أبحر الشمالية، مسموح فيها بالاستخدام التجاري والفلل السكنية. لها أربع واجهات: 60 متراً على طريق بعرض 52 متراً، و148 متراً على طريق بعرض 36 متراً، و148 متراً على طريق بعرض 20 متراً، و60 متراً على طريق بعرض 15 متراً.',
        'السعر المطلوب صافياً 50,000,000 ريال سعودي، أي نحو 5,680 ريالاً للمتر المربع. توضح الصور الجوية القطعة وموقعها على الطريق.',
      ],
    },
    highlights: {
      en: ['8,800 sqm', 'Directly on Abdullah Al Faisal Road', 'Four frontages, 15 m to 52 m roads', 'Commercial and residential villas permitted', 'SAR 50,000,000 net'],
      ar: ['8,800 متر مربع', 'على طريق عبدالله الفيصل مباشرة', 'أربع واجهات على طرق من 15 إلى 52 متراً', 'مسموح بالاستخدام التجاري والفلل السكنية', '50,000,000 ريال سعودي صافياً'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'land-al-hamra-street', sourceRef: 'LND-014', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Land on Al Hamra Street', ar: 'أرض على شارع الحمراء' },
    location: loc({ en: 'Al Hamra', ar: 'الحمراء' }),
    price: { amount: 50000000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 9950.39, yearBuilt: null, floors: null },
    map: { lat: 21.530123603246512, lng: 39.16459296552526 },
    images: [{ local: '/land/LND-014.jpg', room: 'satellite' }, { local: '/land/LND-014-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A city-centre block of 9,950.39 square metres in Al Hamra, open on four sides: the 30-metre Al Hamra Street to the north, the 20-metre Hail Street to the west, and 10-metre streets to the south and east. A surveying decision has already been issued for the licensing process.',
        'The asking price is SAR 50,000,000, about SAR 5,025 per square metre. The satellite frames show the block within the district.',
      ],
      ar: [
        'قطعة في قلب المدينة بمساحة 9,950.39 متراً مربعاً في حي الحمراء، مفتوحة من جهاتها الأربع: شارع الحمراء بعرض 30 متراً شمالاً، وشارع حائل بعرض 20 متراً غرباً، وشارعان بعرض 10 أمتار جنوباً وشرقاً. صدر قرار مساحي بالفعل لإجراءات الترخيص.',
        'السعر المطلوب 50,000,000 ريال سعودي، أي نحو 5,025 ريالاً للمتر المربع. توضح الصور الجوية القطعة داخل الحي.',
      ],
    },
    highlights: {
      en: ['9,950.39 sqm', '30 m Al Hamra Street to the north', '20 m Hail Street to the west', 'Four street frontages', 'Surveying decision issued', 'About SAR 5,025 per sqm'],
      ar: ['9,950.39 متراً مربعاً', 'شارع الحمراء بعرض 30 متراً شمالاً', 'شارع حائل بعرض 20 متراً غرباً', 'أربع واجهات على الشوارع', 'قرار مساحي صادر', 'نحو 5,025 ريالاً للمتر المربع'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'plot-1200-sqm-al-shati', sourceRef: 'LND-015', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Plot of 1,200 sqm behind the Corniche, Al Shati', ar: 'أرض بمساحة 1,200 متر مربع خلف الكورنيش، الشاطئ' },
    location: loc({ en: 'Al Shati', ar: 'الشاطئ' }),
    price: { amount: 10200000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 1200, yearBuilt: null, floors: null },
    map: { lat: 21.562684543496626, lng: 39.11201582272763 },
    images: [{ local: '/land/LND-015.jpg', room: 'satellite' }, { local: '/land/LND-015-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A residential plot of 1,200 square metres in Al Shati, in the row behind the Corniche. The rear of the plot faces toward the Corniche, and access is from a 20-metre street.',
        'The asking price is SAR 10,200,000, at SAR 8,500 per square metre. The satellite frames show the plot and its distance from the shore.',
      ],
      ar: [
        'قطعة أرض سكنية بمساحة 1,200 متر مربع في حي الشاطئ، في الصف الواقع خلف الكورنيش. تتجه الجهة الخلفية للقطعة نحو الكورنيش، والوصول إليها من شارع بعرض 20 متراً.',
        'السعر المطلوب 10,200,000 ريال سعودي، بواقع 8,500 ريال للمتر المربع. توضح الصور الجوية القطعة ومسافتها من الشاطئ.',
      ],
    },
    highlights: {
      en: ['1,200 sqm', 'Rear faces toward the Corniche', 'Access from a 20 m street', 'SAR 8,500 per sqm', 'Al Shati'],
      ar: ['1,200 متر مربع', 'الجهة الخلفية نحو الكورنيش', 'الوصول من شارع بعرض 20 متراً', '8,500 ريال للمتر المربع', 'حي الشاطئ'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'plot-980-sqm-durrat-al-basateen', sourceRef: 'LND-017', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Plot of 980 sqm, Durrat Al Basateen', ar: 'أرض بمساحة 980 متراً مربعاً، درة البساتين' },
    location: loc({ en: 'Durrat Al Basateen', ar: 'درة البساتين' }),
    price: { amount: 8330000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 980, yearBuilt: null, floors: null },
    map: { lat: 21.63689519443776, lng: 39.12082236721488 },
    images: [{ local: '/land/LND-017.jpg', room: 'satellite' }, { local: '/land/LND-017-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A residential plot of 980 square metres in Durrat Al Basateen, north Jeddah, on a 16-metre south-facing street. The district is a low-rise villa neighbourhood close to the coast.',
        'The asking price is SAR 8,330,000, at SAR 8,500 per square metre. The satellite frames show the plot and the surrounding blocks.',
      ],
      ar: [
        'قطعة أرض سكنية بمساحة 980 متراً مربعاً في درة البساتين شمال جدة، على شارع بعرض 16 متراً بواجهة جنوبية. الحي منطقة فلل منخفضة الارتفاع قريبة من الساحل.',
        'السعر المطلوب 8,330,000 ريال سعودي، بواقع 8,500 ريال للمتر المربع. توضح الصور الجوية القطعة والمربعات المحيطة بها.',
      ],
    },
    highlights: {
      en: ['980 sqm', 'South-facing on a 16 m street', 'Villa district near the coast', 'SAR 8,500 per sqm'],
      ar: ['980 متراً مربعاً', 'واجهة جنوبية على شارع بعرض 16 متراً', 'حي فلل قريب من الساحل', '8,500 ريال للمتر المربع'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'plot-450-sqm-al-shati-1', sourceRef: 'LND-020', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Plot of 450 sqm, Al Shati 1', ar: 'أرض بمساحة 450 متراً مربعاً، الشاطئ 1' },
    location: loc({ en: 'Al Shati 1', ar: 'الشاطئ 1' }),
    price: { amount: 3825000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 450, yearBuilt: null, floors: null },
    map: { lat: 21.563638942028028, lng: 39.11882520750281 },
    images: [{ local: '/land/LND-020.jpg', room: 'satellite' }, { local: '/land/LND-020-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A residential plot of 450 square metres in Al Shati 1, on a 32-metre street, a short walk from the sea and the amenities of the district.',
        'The asking price is SAR 3,825,000, at SAR 8,500 per square metre. The satellite frames show the plot and its street.',
      ],
      ar: [
        'قطعة أرض سكنية بمساحة 450 متراً مربعاً في حي الشاطئ 1، على شارع بعرض 32 متراً، على مسافة قصيرة سيراً من البحر ومرافق الحي.',
        'السعر المطلوب 3,825,000 ريال سعودي، بواقع 8,500 ريال للمتر المربع. توضح الصور الجوية القطعة وشارعها.',
      ],
    },
    highlights: {
      en: ['450 sqm', 'On a 32 m street', 'Close to the sea', 'SAR 8,500 per sqm'],
      ar: ['450 متراً مربعاً', 'على شارع بعرض 32 متراً', 'قريبة من البحر', '8,500 ريال للمتر المربع'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'plot-500-sqm-durrat-al-basateen', sourceRef: 'LND-022', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'North-Facing Plot of 500.8 sqm, Durrat Al Basateen', ar: 'أرض بواجهة شمالية بمساحة 500.8 متر مربع، درة البساتين' },
    location: loc({ en: 'Durrat Al Basateen', ar: 'درة البساتين' }),
    price: { amount: 4256800, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 500.8, yearBuilt: null, floors: null },
    map: { lat: 21.637311611993507, lng: 39.12081632967131 },
    images: [{ local: '/land/LND-022.jpg', room: 'satellite' }, { local: '/land/LND-022-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A residential plot of 500.8 square metres in Durrat Al Basateen, north Jeddah, with a north-facing frontage on a 30-metre street. The district is a villa neighbourhood close to the coast.',
        'The asking price is SAR 4,256,800, at SAR 8,500 per square metre. The satellite frames show the plot and the surrounding blocks.',
      ],
      ar: [
        'قطعة أرض سكنية بمساحة 500.8 متر مربع في درة البساتين شمال جدة، بواجهة شمالية على شارع بعرض 30 متراً. الحي منطقة فلل قريبة من الساحل.',
        'السعر المطلوب 4,256,800 ريال سعودي، بواقع 8,500 ريال للمتر المربع. توضح الصور الجوية القطعة والمربعات المحيطة بها.',
      ],
    },
    highlights: {
      en: ['500.8 sqm', 'North-facing on a 30 m street', 'Villa district near the coast', 'SAR 8,500 per sqm'],
      ar: ['500.8 متر مربع', 'واجهة شمالية على شارع بعرض 30 متراً', 'حي فلل قريب من الساحل', '8,500 ريال للمتر المربع'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'corner-plot-al-khalidiyah', sourceRef: 'LND-023', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Corner Plot, Al Khalidiyah', ar: 'أرض زاوية، الخالدية' },
    location: loc({ en: 'Al Khalidiyah', ar: 'الخالدية' }),
    price: { amount: 3937500, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 625, yearBuilt: null, floors: null },
    map: { lat: 21.560239915427147, lng: 39.136093577749236 },
    images: [{ local: '/land/LND-023.jpg', room: 'satellite' }, { local: '/land/LND-023-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A corner plot of 625 square metres in Al Khalidiyah, on two streets, measuring 25 metres on the south side and 25 metres on the west. The district is an established central neighbourhood with schools, shops and quick access to the main roads.',
        'The total price is SAR 3,937,500, at SAR 6,300 per square metre. The satellite frames show the corner and its two streets.',
      ],
      ar: [
        'أرض زاوية بمساحة 625 متراً مربعاً في حي الخالدية، على شارعين، بطول 25 متراً من الجهة الجنوبية و25 متراً من الجهة الغربية. الحي منطقة مركزية راسخة تضم مدارس ومتاجر مع وصول سريع إلى الطرق الرئيسية.',
        'السعر الإجمالي 3,937,500 ريال سعودي، بواقع 6,300 ريال للمتر المربع. توضح الصور الجوية الزاوية وشارعيها.',
      ],
    },
    highlights: {
      en: ['625 sqm corner plot', 'Two streets, south and west', '25 m by 25 m', 'SAR 6,300 per sqm', 'Al Khalidiyah'],
      ar: ['أرض زاوية بمساحة 625 متراً مربعاً', 'شارعان جنوباً وغرباً', '25 في 25 متراً', '6,300 ريال للمتر المربع', 'حي الخالدية'],
    },
    listedAt: '2026-08-26',
  },
  {
    slug: 'plots-300-sqm-al-khalidiyah', sourceRef: 'LND-024', status: 'available', category: 'buy', type: 'land', featured: false,
    title: { en: 'Plots of 300 sqm, Al Khalidiyah', ar: 'قطع أراضٍ بمساحة 300 متر مربع، الخالدية' },
    location: loc({ en: 'Al Khalidiyah', ar: 'الخالدية' }),
    price: { amount: 2150000, currency: 'SAR', from: false, period: null, onRequest: false },
    specs: { beds: null, baths: null, areaSqm: null, plotSqm: 300, yearBuilt: null, floors: null },
    map: { lat: 21.560999987056363, lng: 39.1362687553322 },
    images: [{ local: '/land/LND-024.jpg', room: 'satellite' }, { local: '/land/LND-024-z15.jpg', room: 'satellite_wide' }],
    description: {
      en: [
        'A subdivision of twelve residential plots of 300 square metres each in Al Khalidiyah. Two plots have already sold and ten remain available, individually or in groups.',
        'The price is SAR 2,150,000 per plot, about SAR 7,167 per square metre. The satellite frames show the subdivision and its surroundings.',
      ],
      ar: [
        'مخطط من اثنتي عشرة قطعة سكنية بمساحة 300 متر مربع لكل منها في حي الخالدية. بيعت قطعتان بالفعل وتبقّت عشر قطع متاحة، منفردة أو مجتمعة.',
        'السعر 2,150,000 ريال سعودي للقطعة، أي نحو 7,167 ريالاً للمتر المربع. توضح الصور الجوية المخطط ومحيطه.',
      ],
    },
    highlights: {
      en: ['300 sqm per plot', 'Twelve plots, ten remaining', 'SAR 2,150,000 per plot', 'About SAR 7,167 per sqm', 'Al Khalidiyah'],
      ar: ['300 متر مربع للقطعة', 'اثنتا عشرة قطعة، تبقّت عشر', '2,150,000 ريال سعودي للقطعة', 'نحو 7,167 ريالاً للمتر المربع', 'حي الخالدية'],
    },
    listedAt: '2026-08-26',
  },
];
