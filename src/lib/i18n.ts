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
  navAbout: s('About', 'عن بونا'),
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
    'بوتيك خاص يمثّل محفظة صغيرة منتقاة من الفلل والبنتهاوس والمساكن الواجهية في جدة وما وراءها.'
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
    'بونا بوتيك خاص، لا منصة إعلانات. نتولّى عدداً محدوداً من المنازل في كل مرة، ونعالج كلّاً منها على مستوى الشريك المؤسس: من التسعير والعرض إلى التعريفات الهادئة التي تُتمّ الصفقة.'
  ),
  aboutBona: s('About Bona', 'عن بونا'),
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
  residencesCount: s('{n} residences', '{n} عقار'),
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
  bedsShort: s('bd', 'غرف'),
  bathsShort: s('ba', 'حمام'),
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
