export type Locale = 'en' | 'ar';
export const locales: Locale[] = ['en', 'ar'];
export const defaultLocale: Locale = 'en';

export function dir(locale: Locale): 'ltr' | 'rtl' { return locale === 'ar' ? 'rtl' : 'ltr'; }

/** Localised path: en => '/x/', ar => '/ar/x/'. Always trailing slash. */
export function localePath(locale: Locale, path = '/'): string {
  let p = path.startsWith('/') ? path : `/${path}`;
  if (!p.endsWith('/')) p += '/';
  return locale === 'en' ? p : `/ar${p}`;
}

/** Given a current pathname, return the equivalent path in the other locale. */
export function switchLocalePath(current: string, to: Locale): string {
  const stripped = current.replace(/^\/ar(?=\/|$)/, '') || '/';
  return localePath(to, stripped);
}

export function localeFromPath(pathname: string): Locale {
  return /^\/ar(\/|$)/.test(pathname) ? 'ar' : 'en';
}

/** Pick a localised string from {en, ar} objects, falling back to en. */
export function t<T = string>(obj: { en: T; ar?: T } | undefined | null, locale: Locale): T {
  if (!obj) return '' as unknown as T;
  return (obj[locale] ?? obj.en) as T;
}

const currencyLabel: Record<string, { en: string; ar: string }> = {
  SAR: { en: 'SAR', ar: 'ر.س' }, AED: { en: 'AED', ar: 'د.إ' }, EUR: { en: '€', ar: '€' }, USD: { en: '$', ar: '$' }, OMR: { en: 'OMR', ar: 'ر.ع' },
};

export function formatPrice(price: { amount: number | null; currency: string; from?: boolean; period?: string | null; onRequest?: boolean }, locale: Locale): string {
  if (!price || price.onRequest || price.amount == null) return locale === 'ar' ? 'السعر عند الطلب' : 'Price on request';
  const n = new Intl.NumberFormat('en-US').format(price.amount); // Western digits in both locales (Saudi convention for prices)
  const cur = currencyLabel[price.currency]?.[locale] ?? price.currency;
  const core = locale === 'ar' ? `${n} ${cur}` : (cur.length === 1 ? `${cur}${n}` : `${cur} ${n}`);
  const from = price.from ? (locale === 'ar' ? 'ابتداءً من ' : 'From ') : '';
  const period = price.period ? (locale === 'ar' ? (price.period === 'year' ? ' / سنوياً' : ' / شهرياً') : (price.period === 'year' ? ' / year' : ' / month')) : '';
  return `${from}${core}${period}`;
}

/** Western-digit number (e.g. 1,250) in both locales. */
export function formatNumber(n: number): string { return new Intl.NumberFormat('en-US').format(n); }

/** WhatsApp deep link with a pre-filled message. */
export function waLink(wa: string, message: string): string {
  return `https://wa.me/${wa}?text=${encodeURIComponent(message)}`;
}

/** Other locale (for the language switch). */
export function otherLocale(locale: Locale): Locale { return locale === 'en' ? 'ar' : 'en'; }

/* ------------------------------------------------------------------ */
/* UI strings. Use with t(ui.key, locale).                              */
/* ------------------------------------------------------------------ */
type L = { en: string; ar: string };
const s = (en: string, ar: string): L => ({ en, ar });

export const ui = {
  // Navigation / chrome
  skipToContent: s('Skip to content', 'انتقل إلى المحتوى'),
  navProperties: s('Properties', 'العقارات'),
  navOffPlan: s('Off-Plan', 'على الخارطة'),
  navInternational: s('International', 'عقارات دولية'),
  navAbout: s('About us', 'من نحن'),
  navHouses: s('Houses', 'منازل'),
  navApartments: s('Apartments', 'شقق'),
  navLand: s('Land', 'أراضٍ'),
  navBuildings: s('Buildings', 'عمارات'),
  navAllProperties: s('All properties', 'جميع العقارات'),
  navTours: s('Virtual tours', 'جولات افتراضية'),
  navPrivacy: s('Privacy policy', 'سياسة الخصوصية'),
  navSell: s('Sell', 'بِع معنا'),
  navContact: s('Contact', 'تواصل'),
  languageSwitch: s('العربية', 'English'),
  languageSwitchAria: s('Switch to Arabic', 'التبديل إلى الإنجليزية'),
  openMenu: s('Open menu', 'فتح القائمة'),
  closeMenu: s('Close menu', 'إغلاق القائمة'),
  menu: s('Menu', 'القائمة'),
  whatsapp: s('WhatsApp', 'واتساب'),
  chatOnWhatsApp: s('Chat on WhatsApp', 'تواصل عبر واتساب'),
  callUs: s('Call', 'اتصل'),
  instagram: s('Instagram', 'إنستغرام'),
  home: s('Home', 'الرئيسية'),
  privateRealEstate: s('Private real estate, Jeddah', 'عقارات خاصة، جدة'),
  allRightsReserved: s('All rights reserved.', 'جميع الحقوق محفوظة.'),
  regaLicence: s('REGA FAL licence', 'رخصة فال — الهيئة العامة للعقار'),
  crNumber: s('CR', 'س.ت'),
  footerNav: s('Navigate', 'التنقل'),
  footerContact: s('Contact', 'التواصل'),
  footerVisit: s('Visit', 'العنوان'),

  // Home
  heroSubline: s(
    'A private boutique representing a small, curated portfolio of villas, penthouses and waterfront residences in Jeddah and beyond.',
    'بوتيك خاص يمثّل محفظة صغيرة منتقاة من الفلل والبنتهاوس ومساكن الواجهة البحرية في جدة وخارجها.'
  ),
  exploreProperties: s('Explore properties', 'استعرض العقارات'),
  privateEnquiry: s('Private enquiry', 'استفسار خاص'),
  selectedResidences: s('Selected residences', 'مساكن مختارة'),
  selectedResidencesIntro: s('A few of the homes we are representing at the moment.', 'بعض المنازل التي نمثّلها حالياً.'),
  viewAllProperties: s('View all properties', 'جميع العقارات'),
  markets: s('Markets', 'الأسواق'),
  marketsIntro: s('Jeddah first. Then the places our clients keep returning to.', 'جدة أولاً، ثم الوجهات التي يعود إليها عملاؤنا.'),
  theHouse: s('The house', 'الدار'),
  homeAboutStatement: s(
    'Bona is a private boutique, not a portal. We take on a handful of homes at a time and handle each one at principal level, from pricing and presentation to the quiet introductions that close.',
    'بونا بوتيك خاص، لا منصة إعلانات. نتولّى عدداً محدوداً من المنازل في كل مرة، ونعالج كلّاً منها على مستوى الشركاء: من التسعير والعرض إلى التعريفات الهادئة التي تُتمّ الصفقة.'
  ),
  aboutBona: s('About us', 'من نحن'),
  sellWithBona: s('Sell with Bona', 'بِع مع بونا'),
  sellBandText: s(
    'Discreet marketing, qualified buyers and one point of contact from the first conversation to the handover.',
    'تسويق بتحفّظ، ومشترون جادّون، وجهة تواصل واحدة من أول محادثة حتى التسليم.'
  ),
  listYourProperty: s('List your property', 'اعرض عقارك'),
  followOnInstagram: s('Follow the house on Instagram', 'تابع الدار على إنستغرام'),
  instagramBandText: s('New residences, walkthroughs and a little of Jeddah, most days.', 'مساكن جديدة وجولات ولمحات من جدة، في أغلب الأيام.'),
  speakWithUs: s('Speak with us', 'تحدّث معنا'),
  contactBandText: s('WhatsApp is the fastest way to reach us. We reply personally, usually within the hour.', 'واتساب أسرع طريقة للوصول إلينا. نردّ شخصياً، وغالباً خلال ساعة.'),

  // Properties
  properties: s('Properties', 'العقارات'),
  propertiesIntro: s('Every residence Bona currently represents, in Jeddah, Riyadh and a few places further afield.', 'كل المساكن التي تمثّلها بونا حالياً، في جدة والرياض ووجهات أبعد قليلاً.'),
  all: s('All', 'الكل'),
  allTypes: s('All types', 'كل الأنواع'),
  type: s('Type', 'النوع'),
  sortBy: s('Sort', 'الترتيب'),
  sortNewest: s('Newest', 'الأحدث'),
  sortPriceHigh: s('Price, high to low', 'السعر: من الأعلى'),
  sortPriceLow: s('Price, low to high', 'السعر: من الأدنى'),
  residencesCount: s('{n} residences', '{n} عقار'), // AR: use arCount(n, 'residence') instead
  residenceCountOne: s('1 residence', 'عقار واحد'),
  noMatches: s('No residences match these filters.', 'لا توجد عقارات تطابق هذه الخيارات.'),
  clearFilters: s('Clear filters', 'مسح الخيارات'),
  forSaleTitle: s('Homes for sale', 'عقارات للبيع'),
  forSaleIntro: s('Villas, penthouses and apartments for sale in Jeddah and Riyadh, represented by Bona.', 'فلل وبنتهاوس وشقق للبيع في جدة والرياض، تمثّلها بونا.'),
  forRentTitle: s('Homes for rent', 'عقارات للإيجار'),
  forRentIntro: s('Furnished and unfurnished residences to rent, chosen with the same care as the homes we sell.', 'مساكن للإيجار، مفروشة وغير مفروشة، اخترناها بالعناية نفسها التي نختار بها ما نبيعه.'),
  offPlanTitle: s('Off-plan residences', 'مشاريع على الخارطة'),
  offPlanIntro: s('Branded residences and new developments from developers we know and trust.', 'مساكن بعلامات عالمية ومشاريع جديدة من مطوّرين نعرفهم ونثق بهم.'),
  internationalTitle: s('International', 'عقارات دولية'),
  internationalIntro: s('A small selection abroad: Dubai, the Côte d’Azur, the Costa del Sol and Oman, through partners we have worked with for years.', 'مجموعة صغيرة خارج المملكة: دبي والريفييرا الفرنسية وكوستا ديل سول وعُمان، عبر شركاء نعمل معهم منذ سنوات.'),

  // Listing detail
  reference: s('Reference', 'الرقم المرجعي'),
  bedrooms: s('Bedrooms', 'غرف النوم'),
  bathrooms: s('Bathrooms', 'دورات المياه'),
  builtArea: s('Built area', 'مساحة البناء'),
  plot: s('Plot', 'مساحة الأرض'),
  yearBuilt: s('Year built', 'سنة البناء'),
  floors: s('Floors', 'الأدوار'),
  sqm: s('sqm', 'م²'),
  bedsShort: s('bd', 'غرفة'),
  bathsShort: s('ba', 'حمّام'),
  highlights: s('Highlights', 'المميزات'),
  brochure: s('Download brochure', 'تحميل الكتيّب'),
  virtualTour: s('Virtual tour', 'جولة افتراضية'),
  enquireWhatsApp: s('Enquire on WhatsApp', 'استفسر عبر واتساب'),
  enquiryPanelText: s('One message and a principal will come back to you personally.', 'رسالة واحدة، ويردّ عليك أحد شركاء الدار شخصياً.'),
  similarResidences: s('Similar residences', 'مساكن مشابهة'),
  sold: s('Sold', 'مباع'),
  reserved: s('Reserved', 'محجوز'),
  gallery: s('Gallery', 'معرض الصور'),
  viewAllPhotos: s('View all photos', 'عرض كل الصور'),
  openGallery: s('Open gallery', 'فتح المعرض'),
  previousImage: s('Previous image', 'الصورة السابقة'),
  nextImage: s('Next image', 'الصورة التالية'),
  close: s('Close', 'إغلاق'),
  aboutThisResidence: s('About this residence', 'عن هذا المسكن'),
  listingWaMessage: s('Hello Bona, I’m interested in {title} ({id}) — {url}', 'مرحباً بونا، أرغب في الاستفسار عن {title} ({id}) — {url}'),

  // About
  aboutTitle: s('The house', 'الدار'),
  aboutMetaTitle: s('About Bona, a private real estate boutique in Jeddah', 'عن بونا، بوتيك عقاري خاص في جدة'),
  aboutMetaDesc: s('Bona is an independent luxury real estate boutique in Jeddah with a small, curated portfolio and principal-level handling, working across Saudi Arabia and select international markets.', 'بونا بوتيك عقاري فاخر مستقل في جدة، بمحفظة صغيرة منتقاة وتعامل على مستوى الشركاء، يعمل في المملكة ووجهات دولية مختارة.'),

  // Sell
  sellTitle: s('Sell with Bona', 'بِع مع بونا'),
  sellMetaTitle: s('Sell your home with Bona, Jeddah', 'بِع منزلك مع بونا، جدة'),
  sellMetaDesc: s('Discreet marketing, qualified buyers, an off-market network and one point of contact. List your villa, penthouse or apartment with Bona in Jeddah.', 'تسويق بتحفّظ ومشترون جادّون وشبكة خارج السوق وجهة تواصل واحدة. اعرض فيلتك أو البنتهاوس أو شقتك مع بونا في جدة.'),
  howItWorks: s('How it works', 'كيف نعمل'),
  sellerEnquiry: s('Tell us about your property', 'أخبرنا عن عقارك'),

  // Contact
  contactTitle: s('Contact', 'تواصل معنا'),
  contactMetaTitle: s('Contact Bona, Jeddah', 'تواصل مع بونا، جدة'),
  contactMetaDesc: s('Reach Bona on WhatsApp or by phone, or visit us in Al Rawdah, Jeddah. Private enquiries answered personally.', 'تواصل مع بونا عبر واتساب أو الهاتف، أو زرنا في حي الروضة بجدة. نردّ على الاستفسارات الخاصة شخصياً.'),
  contactIntro: s('Write to us the way you would write to a friend who happens to know every good house in Jeddah.', 'راسلنا كما تراسل صديقاً يعرف كل بيت جيد في جدة.'),
  phone: s('Phone', 'الهاتف'),
  address: s('Address', 'العنوان'),
  hours: s('Hours', 'ساعات العمل'),
  openInMaps: s('Open in Google Maps', 'فتح في خرائط جوجل'),
  mapTitle: s('Map showing the Bona office in Al Rawdah, Jeddah', 'خريطة تُظهر مكتب بونا في حي الروضة، جدة'),
  sendMessage: s('Send a message', 'أرسل رسالة'),

  // Forms
  formName: s('Your name', 'الاسم'),
  formPhone: s('Phone or WhatsApp number', 'رقم الجوال أو واتساب'),
  formInterest: s('I would like to', 'أرغب في'),
  interestBuy: s('Buy', 'الشراء'),
  interestSell: s('Sell', 'البيع'),
  interestRent: s('Rent', 'الإيجار'),
  formPropertyType: s('Property type', 'نوع العقار'),
  formBudget: s('Budget or preferred location', 'الميزانية أو الموقع المفضّل'),
  formLocation: s('Property location', 'موقع العقار'),
  formRef: s('Property reference', 'الرقم المرجعي للعقار'),
  formMessage: s('Message', 'رسالتك'),
  formOptional: s('optional', 'اختياري'),
  formSubmit: s('Send via WhatsApp', 'إرسال عبر واتساب'),
  formNote: s('Your message opens in WhatsApp. Nothing is stored on this site.', 'تُفتح رسالتك في واتساب. لا يُخزَّن شيء على هذا الموقع.'),
  formErrName: s('Please enter your name.', 'يرجى إدخال الاسم.'),
  formErrPhone: s('Please enter a valid phone number, with the country code if outside Saudi Arabia.', 'يرجى إدخال رقم جوال صحيح، مع رمز الدولة إن كان خارج السعودية.'),
  formThanks: s('Thank you. WhatsApp should open with your message ready to send.', 'شكراً لك. سيُفتح واتساب ورسالتك جاهزة للإرسال.'),
  formThanksFallback: s('If it didn’t open, use the button below.', 'إن لم يُفتح، استخدم الزر أدناه.'),
  formOpenWhatsApp: s('Open WhatsApp', 'فتح واتساب'),
  formGreeting: s('Hello Bona,', 'مرحباً بونا،'),
  formSeparator: s(': ', ': '),
  labelName: s('Name', 'الاسم'),
  labelPhone: s('Phone', 'الجوال'),
  labelInterest: s('Interest', 'الغرض'),
  labelType: s('Type', 'النوع'),
  labelBudget: s('Budget / location', 'الميزانية / الموقع'),
  labelLocation: s('Location', 'الموقع'),
  labelRef: s('Reference', 'المرجع'),
  labelMessage: s('Message', 'الرسالة'),
  sentFrom: s('Sent from', 'مُرسَلة من'),

  // Home — kind sections
  housesTitle: s('Houses', 'منازل'),
  housesIntro: s('Villas, mansions and private houses we are representing at the moment.', 'فلل وقصور ومنازل خاصة نمثّلها حالياً.'),
  viewAllHouses: s('All houses', 'جميع المنازل'),
  apartmentsTitle: s('Apartments', 'شقق'),
  apartmentsIntro: s('Penthouses, branded residences and apartments, in Jeddah and beyond.', 'بنتهاوس ومساكن بعلامات عالمية وشقق، في جدة وخارجها.'),
  viewAllApartments: s('All apartments', 'جميع الشقق'),
  landTitle: s('Land', 'أراضٍ'),
  landIntro: s('Residential and development plots in and around Jeddah.', 'أراضٍ سكنية وتطويرية في جدة وما حولها.'),
  viewAllLand: s('All land', 'جميع الأراضي'),
  scrollCue: s('Scroll', 'مرّر'),
  heroSlideshow: s('Featured residences', 'مساكن مميّزة'),

  // Properties — kind pages
  housesPageTitle: s('Houses', 'المنازل'),
  housesPageIntro: s('Villas, mansions, duplexes and private houses represented by Bona: for sale, for rent and off-plan.', 'فلل وقصور ودوبلكس ومنازل خاصة تمثّلها بونا: للبيع وللإيجار وعلى الخارطة.'),
  apartmentsPageTitle: s('Apartments', 'الشقق'),
  apartmentsPageIntro: s('Apartments, penthouses and units in branded developments, in Jeddah, Riyadh and abroad.', 'شقق وبنتهاوس ووحدات في مشاريع بعلامات عالمية، في جدة والرياض وخارج المملكة.'),
  landPageTitle: s('Land', 'الأراضي'),
  landPageIntro: s('Plots for private houses and development projects, with aerial views and location maps.', 'قطع أراضٍ للمنازل الخاصة ومشاريع التطوير، مع صور جوية وخرائط للموقع.'),
  buildingsPageTitle: s('Buildings', 'العمارات'),
  buildingsPageIntro: s('Residential and mixed-use buildings offered as whole assets.', 'عمارات سكنية ومتعددة الاستخدام تُعرض كأصول كاملة.'),
  viewPill: s('View', 'عرض'),
  project: s('Project', 'المشروع'),
  developer: s('Developer', 'المطوّر'),
  unit: s('Unit', 'الوحدة'),
  floor: s('Floor', 'الدور'),
  block: s('Block', 'المبنى'),
  openMap: s('Open location in Google Maps', 'فتح الموقع في خرائط جوجل'),

  // Matterport / tours
  tour3dTitle: s('Walk through in 3D', 'تجوّل في العقار بتقنية ثلاثية الأبعاد'),
  tour3dIntro: s('A Matterport scan of the residence. Move from room to room, look around and measure, before you visit.', 'مسح ماتربورت للمسكن. تنقّل بين الغرف وانظر حولك وقِس الأبعاد، قبل الزيارة.'),
  playTour: s('Start the 3D tour', 'ابدأ الجولة ثلاثية الأبعاد'),
  openInMatterport: s('Open in Matterport', 'فتح في ماتربورت'),
  tourFrameTitle: s('3D tour of {title}', 'جولة ثلاثية الأبعاد في {title}'),
  badge3d: s('3D tour', 'جولة ثلاثية الأبعاد'),
  toursTitle: s('Virtual tours', 'جولات افتراضية'),
  toursIntro: s('Walk through these residences in 3D before you visit. New tours are added as homes are scanned.', 'تجوّل في هذه المساكن بتقنية ثلاثية الأبعاد قبل زيارتها. تُضاف جولات جديدة كلما صُوّر منزل.'),
  toursMetaTitle: s('Virtual 3D tours of homes in Jeddah', 'جولات افتراضية ثلاثية الأبعاد لمنازل في جدة'),
  toursMetaDesc: s('Matterport 3D walkthroughs of villas, apartments and residences represented by Bona in Jeddah. Explore room by room before you visit.', 'جولات ماتربورت ثلاثية الأبعاد في فلل وشقق ومساكن تمثّلها بونا في جدة. استكشف غرفةً غرفة قبل الزيارة.'),
  toursEmpty: s('No virtual tours are available at the moment. New scans are added regularly.', 'لا تتوفر جولات افتراضية حالياً. تُضاف جولات جديدة بانتظام.'),

  // Privacy
  privacyMetaDesc: s('How Bona handles the personal information you share with us, on this site and on WhatsApp.', 'كيف تتعامل بونا مع المعلومات الشخصية التي تشاركها معنا، على هذا الموقع وعبر واتساب.'),
  lastUpdated: s('Last updated', 'آخر تحديث'),
  onThisPage: s('On this page', 'في هذه الصفحة'),
  privacyContactTitle: s('Questions about your data', 'أسئلة حول بياناتك'),
  privacyEmpty: s('The full policy is being finalised. Until then: we store nothing on this site; enquiries open in WhatsApp and are handled personally.', 'يجري إعداد السياسة الكاملة. حتى ذلك الحين: لا نخزّن شيئاً على هذا الموقع؛ تُفتح الاستفسارات في واتساب وتُعالَج شخصياً.'),

  // About us (data-driven)
  aboutH1: s('A private house for exceptional homes', 'دار خاصة للمنازل الاستثنائية'),
  aboutStatementFallback: s('Bona takes its name from the Latin for good things: property, in the oldest sense of the word. We are an independent real estate boutique in Jeddah, deliberately small, representing a handful of homes at a time.', 'تستمدّ بونا اسمها من الكلمة اللاتينية Bona، أي «الأشياء الطيّبة»: الملكية بمعناها الأقدم. نحن بوتيك عقاري مستقل في جدة، صغير عن قصد، يمثّل عدداً محدوداً من المنازل في كل مرة.'),
  ourStory: s('Our story', 'قصتنا'),
  ourValues: s('What we stand for', 'ما نؤمن به'),
  thePrincipals: s('The principals', 'الشركاء'),
  principalsIntro: s('The people who will answer your message.', 'الأشخاص الذين سيردّون على رسالتك.'),
  falLicence: s('FAL licence', 'رخصة فال'),
  inNumbers: s('In numbers', 'بالأرقام'),
  aboutClosing: s('If you are thinking about a home, or about selling one, the conversation costs nothing and stays between us.', 'إن كنت تفكّر في منزل، أو في بيع منزل، فالمحادثة لا تكلّف شيئاً وتبقى بيننا.'),
  contactUs: s('Contact us', 'تواصل معنا'),

  // Gallery strip / lightbox
  galleryProgress: s('Gallery position', 'موضع المعرض'),
  thumbnails: s('Thumbnails', 'الصور المصغّرة'),
  goToImage: s('Go to image {n}', 'الانتقال إلى الصورة {n}'),

  // Concierge — Dana (chat + browser voice call). Shared by the panel markup and its client script.
  conciergeOpen: s('Concierge', 'الكونسيرج'),
  conciergeRole: s('Bona concierge', 'كونسيرج بونا'),
  conciergeClose: s('Close the concierge', 'إغلاق الكونسيرج'),
  conciergeTabs: s('Concierge', 'الكونسيرج'),
  conciergeTabChat: s('Chat', 'محادثة'),
  conciergeTabCall: s('Call', 'مكالمة'),
  conciergeConversation: s('Conversation with Dana', 'المحادثة مع دانة'),
  conciergeYou: s('You', 'أنت'),
  conciergeTyping: s('Dana is typing', 'دانة تكتب'),
  conciergeInputLabel: s('Write to Dana', 'اكتب إلى دانة'),
  conciergePlaceholder: s('Ask about a home, a district, a viewing…', 'اسأل عن منزل أو حي أو موعد معاينة…'),
  conciergeSend: s('Send', 'إرسال'),
  conciergeNewConversation: s('New conversation', 'محادثة جديدة'),
  conciergeOpening: s('Opening the page…', 'جارٍ فتح الصفحة…'),
  conciergeQuickViewing: s('Book a viewing', 'حجز معاينة'),
  conciergeQuickHuman: s('Talk to a person', 'التحدّث مع شخص'),
  conciergeQuickHousesMsg: s('Show me the houses you represent.', 'أرني المنازل التي تمثّلونها.'),
  conciergeQuickApartmentsMsg: s('Show me the apartments you represent.', 'أرني الشقق التي تمثّلونها.'),
  conciergeQuickViewingMsg: s('I would like to book a viewing.', 'أرغب في حجز موعد لمعاينة عقار.'),
  conciergeQuickHumanMsg: s('I would like to speak with someone from Bona.', 'أرغب في التحدّث مع أحد من بونا.'),
  conciergeOfflineTitle: s('Dana is resting', 'دانة في استراحة'),
  conciergeOfflineText: s('The concierge is not reachable at the moment. Write to us on WhatsApp and a principal will reply personally.', 'الكونسيرج غير متاح في هذه اللحظة. راسلنا عبر واتساب وسيردّ عليك أحد شركاء الدار شخصياً.'),
  conciergeRetry: s('Try again', 'إعادة المحاولة'),
  conciergeAskDana: s('Ask Dana', 'اسأل دانة'),
  conciergeAskAboutHome: s('Ask Dana about this home', 'اسأل دانة عن هذا المنزل'),
  conciergeAskAboutHomeMsg: s('Tell me about {title} ({id}).', 'حدّثيني عن {title} ({id}).'),
  conciergeCallIntro: s('A voice conversation in your browser, in Arabic or English. The microphone is used only while the call is running.', 'محادثة صوتية داخل المتصفح، بالعربية أو الإنجليزية. لا يُستخدم الميكروفون إلا أثناء المكالمة.'),
  conciergeCallStart: s('Start the call', 'ابدأ المكالمة'),
  conciergeCallIdle: s('Ready when you are', 'جاهزة متى شئت'),
  conciergeCallPermission: s('Waiting for the microphone…', 'في انتظار إذن الميكروفون…'),
  conciergeCallConnecting: s('Connecting…', 'جارٍ الاتصال…'),
  conciergeCallLive: s('Dana is listening', 'دانة تستمع إليك'),
  conciergeCallSpeaking: s('Dana is speaking', 'دانة تتحدّث'),
  conciergeCallEnded: s('Call ended', 'انتهت المكالمة'),
  conciergeCallNotConnected: s('We could not connect', 'تعذّر الاتصال'),
  conciergeCallEnd: s('End call', 'إنهاء المكالمة'),
  conciergeCallMute: s('Mute', 'كتم الصوت'),
  conciergeCallUnmute: s('Unmute', 'إلغاء الكتم'),
  conciergeCallTimer: s('Call duration', 'مدة المكالمة'),
  conciergeCallMentioned: s('Mentioned properties', 'عقارات ذُكرت في المكالمة'),
  conciergeMicDenied: s('The microphone is blocked for this site. Allow it in your browser, or reach us another way.', 'الميكروفون محجوب لهذا الموقع. اسمح به من إعدادات المتصفح، أو تواصل معنا بطريقة أخرى.'),
  conciergeCallUnsupported: s('This browser cannot place a voice call. Call us or write on WhatsApp instead.', 'هذا المتصفح لا يدعم المكالمات الصوتية. اتصل بنا أو راسلنا عبر واتساب.'),
  conciergeCallFailed: s('The call could not be connected. Call us or write on WhatsApp instead.', 'تعذّر إجراء المكالمة. اتصل بنا أو راسلنا عبر واتساب.'),
  conciergeAiNote: s('Dana is an AI concierge. Conversations may be recorded and transcribed for quality.', 'دانة كونسيرج يعمل بالذكاء الاصطناعي. قد تُسجَّل المحادثات وتُفرَّغ نصياً لأغراض الجودة.'),

  // 404
  notFoundTitle: s('This page has moved on', 'هذه الصفحة لم تعد هنا'),
  notFoundText: s('The address may have changed, or the residence is no longer listed.', 'ربما تغيّر العنوان، أو لم يعد المسكن معروضاً.'),
  backHome: s('Back to the home page', 'العودة إلى الرئيسية'),
  browseProperties: s('Browse properties', 'تصفّح العقارات'),
} as const;

export type UiKey = keyof typeof ui;

/** Replace {placeholders} in a UI string. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/** Arabic-aware count phrases. Forms: one/two/few(3–10)/many(11+)/other; falls back to EN "{n} unit(s)". */
const countForms: Record<string, { en: [string, string]; ar: { zero: string; one: string; two: string; few: string; many: string; other: string } }> = {
  residence: { en: ['residence', 'residences'], ar: { zero: 'لا توجد عقارات', one: 'عقار واحد', two: 'عقاران', few: '{n} عقارات', many: '{n} عقاراً', other: '{n} عقار' } },
  bed: { en: ['bd', 'bd'], ar: { zero: 'بلا غرف', one: 'غرفة واحدة', two: 'غرفتان', few: '{n} غرف', many: '{n} غرفة', other: '{n} غرفة' } },
  bath: { en: ['ba', 'ba'], ar: { zero: 'بلا حمّامات', one: 'حمّام واحد', two: 'حمّامان', few: '{n} حمّامات', many: '{n} حمّاماً', other: '{n} حمّام' } },
  photo: { en: ['photo', 'photos'], ar: { zero: 'لا توجد صور', one: 'صورة واحدة', two: 'صورتان', few: '{n} صور', many: '{n} صورة', other: '{n} صورة' } },
};
export function count(n: number, unit: keyof typeof countForms, locale: Locale): string {
  const f = countForms[unit];
  if (locale !== 'ar') return `${n} ${n === 1 ? f.en[0] : f.en[1]}`;
  const cat = new Intl.PluralRules('ar').select(n) as keyof typeof f.ar;
  return (f.ar[cat] ?? f.ar.other).replace('{n}', String(n));
}
/** Serialisable AR plural forms for client scripts (data-attributes). */
export function countForms_(unit: keyof typeof countForms) { return countForms[unit]; }
