#!/usr/bin/env node
/* Generates the Instagram launch kit + 30-day calendar from src/data/listings.json:
     src/data/content-calendar.json   (machine-readable; dashboard reads it)
     marketing/content-calendar.md    (human table)
     marketing/launch-posts.md        (9 launch-day grid posts, EN+AR, image URLs, alt text, hashtags)
     marketing/captions/*.txt         (ready for scripts/instagram-post.mjs --caption-file)
   Re-run whenever listings.json changes:  node scripts/og/gen-social.mjs
   Options: --start 2026-09-06   --days 30 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const START = opt('--start', '2026-09-06');
const DAYS = Number(opt('--days', 30));

const site = JSON.parse(fs.readFileSync(path.join(root, 'src/data/site.json'), 'utf8'));
const listings = JSON.parse(fs.readFileSync(path.join(root, 'src/data/listings.json'), 'utf8'));
const base = site.url.replace(/\/$/, '');
const WA = site.whatsapp.display;
const OG = `${base}/og-default.png`;
const live = listings.filter((l) => l.status !== 'sold' && l.images?.length);
const placeholder = live.length < 6;
if (placeholder) console.warn(`warning: only ${live.length} live listing(s) with images — output uses fallbacks; re-run after the data agent lands real listings.`);

// ---------- helpers ----------
const typeLabel = { villa: { en: 'Villa', ar: 'فيلا' }, apartment: { en: 'Apartment', ar: 'شقة' }, penthouse: { en: 'Penthouse', ar: 'بنتهاوس' }, mansion: { en: 'Mansion', ar: 'قصر' }, duplex: { en: 'Duplex', ar: 'دوبلكس' }, building: { en: 'Building', ar: 'عمارة' }, land: { en: 'Land', ar: 'أرض' } };
const cur = { SAR: { en: 'SAR', ar: 'ر.س' }, AED: { en: 'AED', ar: 'د.إ' }, EUR: { en: '€', ar: '€' }, USD: { en: '$', ar: '$' }, OMR: { en: 'OMR', ar: 'ر.ع' } };
function price(p, l) {
  if (!p || p.onRequest || p.amount == null) return l === 'ar' ? 'السعر عند الطلب' : 'Price on request';
  const n = new Intl.NumberFormat('en-US').format(p.amount);
  const c = cur[p.currency]?.[l] ?? p.currency;
  const core = l === 'ar' ? `${n} ${c}` : c.length === 1 ? `${c}${n}` : `${c} ${n}`;
  const from = p.from ? (l === 'ar' ? 'ابتداءً من ' : 'From ') : '';
  const per = p.period ? (l === 'ar' ? (p.period === 'year' ? ' / سنوياً' : ' / شهرياً') : p.period === 'year' ? ' / year' : ' / month') : '';
  return `${from}${core}${per}`;
}
const t = (o, l) => (o?.[l] ?? o?.en ?? '');
const url = (l, lang) => `${base}${lang === 'ar' ? '/ar' : ''}/properties/${l.slug}/`;
const heroOf = (l) => l.images?.[0]?.src || OG;
const imgs = (l, n = 5) => (l.images || []).slice(0, n).map((i) => i.src);
const altOf = (l, lang) => t(l.images?.[0]?.alt, lang) || `${t(typeLabel[l.type], lang)} — ${t(l.location.district, lang)}`;

const H = {
  core: ['#بونا', '#عقارات_جدة', '#جدة', '#عقارات_السعودية', '#jeddahrealestate', '#luxuryrealestate', '#jeddah', '#saudirealestate', '#bona'],
  villa: ['#فلل_جدة', '#فلل_للبيع_في_جدة', '#فلل_فاخرة_جدة', '#فيلا_للبيع', '#luxuryvilla', '#villaforsale', '#jeddahvillas', '#luxuryhomes'],
  apartment: ['#شقق_جدة', '#شقق_فاخرة_جدة', '#شقق_للبيع', '#luxuryapartment', '#jeddahapartments', '#apartmentforsale', '#luxuryliving'],
  penthouse: ['#بنتهاوس_جدة', '#بنتهاوس', '#شقق_فاخرة_جدة', '#penthouse', '#penthouselife', '#luxuryapartment', '#luxuryliving'],
  mansion: ['#قصور_جدة', '#قصر_للبيع', '#فلل_فاخرة_جدة', '#mansion', '#luxuryvilla', '#luxuryhomes', '#jeddahvillas'],
  land: ['#اراضي_جدة', '#أرض_للبيع', '#landforsale', '#jeddahland', '#investinjeddah', '#استثمار_عقاري'],
  building: ['#عمارة_للبيع', '#عقارات_استثمارية', '#buildingforsale', '#investinjeddah', '#استثمار_عقاري'],
  duplex: ['#دوبلكس_جدة', '#دوبلكس_للبيع', '#فلل_جدة', '#duplex', '#luxuryhomes', '#jeddahvillas'],
  rent: ['#للإيجار', '#فلل_للإيجار_جدة', '#شقق_للإيجار_جدة', '#villaforrent', '#jeddahrentals', '#luxuryrental'],
  water: ['#عقارات_الشاطئ', '#واجهة_بحرية', '#waterfrontliving', '#beachfrontvilla', '#seaview', '#redsea'],
  edu: ['#نصائح_عقارية', '#دليل_المشتري', '#شراء_عقار', '#realestatetips', '#homebuyingtips', '#jeddahproperty', '#saudiproperty'],
  brand: ['#منازل_استثنائية', '#quietluxury', '#luxuryinteriors', '#architecture', '#jeddahlife', '#saudiluxury', '#عمارة'],
  intl: ['#عقارات_دولية', '#internationalproperty', '#luxuryhomes', '#secondhome'],
  district: {
    'al khalidiyah': ['#الخالدية', '#alkhalidiyah'], 'khalidiyah': ['#الخالدية', '#alkhalidiyah'],
    'obhur': ['#أبحر', '#ابحر_الشمالية', '#obhur', '#northobhur'], 'abhur': ['#أبحر', '#ابحر_الشمالية', '#obhur'], 'sheraa': ['#الشراع', '#أبحر', '#obhur'], 'bandar': ['#البندر', '#أبحر', '#obhur'],
    'al shati': ['#الشاطئ', '#حي_الشاطئ', '#alshati'], 'shati': ['#الشاطئ', '#alshati'],
    'al rawdah': ['#الروضة', '#alrawdah'], 'rawdah': ['#الروضة', '#alrawdah'],
    'al zahra': ['#الزهراء', '#alzahra'], 'zahra': ['#الزهراء', '#alzahra'],
    'al salamah': ['#السلامة', '#alsalamah'], 'salamah': ['#السلامة', '#alsalamah'],
    'mohammadiyah': ['#المحمدية', '#almohammadiyah'], 'mohamadiyah': ['#المحمدية', '#almohammadiyah'],
    'nahdah': ['#النهضة', '#alnahdah'], 'nahda': ['#النهضة', '#alnahdah'],
    'murjan': ['#المرجان', '#almurjan'], 'basateen': ['#البساتين', '#albasateen'],
    'durrat': ['#درة_العروس', '#durratalarous'], 'andalus': ['#الأندلس', '#alandalus'], 'hamra': ['#الحمراء', '#alhamra'],
    'riyadh': ['#عقارات_الرياض', '#الرياض', '#riyadh', '#riyadhrealestate'], 'wadi safar': ['#وادي_صفار', '#wadisafar', '#riyadh'],
    'dubai': ['#عقارات_دبي', '#دبي', '#dubai', '#dubairealestate'], 'muscat': ['#عقارات_عمان', '#مسقط', '#oman', '#muscat'], 'aida': ['#aidaoman', '#مسقط', '#oman'],
    'cannes': ['#cannes', '#cotedazur', '#frenchriviera', '#كان'], 'marbella': ['#marbella', '#costadelsol', '#ماربيا'], 'benahav': ['#marbella', '#benahavis', '#costadelsol'], 'france': ['#عقارات_فرنسا', '#frenchproperty'],
  },
};
const uniq = (a) => [...new Set(a)];
function tagsFor(l) {
  const d = `${t(l.location.district, 'en')} ${t(l.location.city, 'en')}`.toLowerCase();
  const dist = Object.entries(H.district).filter(([k]) => d.includes(k)).flatMap(([, v]) => v);
  const water = /beach|sea|water|corniche|obhur|durrat|shati|marina|creek/i.test(`${d} ${t(l.title, 'en')} ${(l.highlights?.en || []).join(' ')}`) ? H.water.slice(0, 3) : [];
  const type = H[l.type] || H.villa;
  const cat = l.category === 'rent' ? H.rent.slice(0, 3) : l.category === 'international' ? H.intl.slice(0, 2) : [];
  return uniq([...H.core.slice(0, 6), ...type.slice(0, 6), ...dist.slice(0, 3), ...water, ...cat, '#bona']).slice(0, 20);
}
const spec = (l, lang) => {
  const s = l.specs || {};
  const bits = [];
  if (s.beds) bits.push(lang === 'ar' ? `${s.beds} غرف نوم` : `${s.beds} bedrooms`);
  if (s.baths) bits.push(lang === 'ar' ? `${s.baths} دورات مياه` : `${s.baths} bathrooms`);
  if (s.areaSqm) bits.push(lang === 'ar' ? `${s.areaSqm} م²` : `${s.areaSqm} m²`);
  if (s.plotSqm) bits.push(lang === 'ar' ? `أرض ${s.plotSqm} م²` : `${s.plotSqm} m² plot`);
  return bits.join(' · ');
};
const firstPara = (s) => (s || '').trim().split(/\n\s*\n/)[0].trim();
const AD = { en: 'REGA ad licence: [add number before publishing]', ar: 'رقم ترخيص الإعلان العقاري: [يُضاف قبل النشر]' };
const CTA = {
  en: (l) => `Ref. ${l.id} — WhatsApp ${WA} or the link in bio.`,
  ar: (l) => `المرجع ${l.id} — واتساب ${WA} أو الرابط في البايو.`,
};
const openers = {
  en: ['', 'Quietly available.', 'Now available through Bona.', 'By private appointment.', 'Off the portals, on our list.'],
  ar: ['', 'متاح بهدوء.', 'متاح الآن عبر بونا.', 'المعاينة بموعد خاص.', 'خارج المنصات، ضمن قائمتنا.'],
};
function listingCaption(l, lang, i = 0) {
  const lines = [];
  const op = openers[lang][i % openers[lang].length];
  if (op) lines.push(op);
  lines.push(t(l.title, lang));
  lines.push(`${t(l.location.district, lang)}، ${t(l.location.city, lang)}`.replace('،', lang === 'ar' ? '،' : ','));
  const sp = spec(l, lang);
  if (sp) lines.push(sp);
  lines.push('');
  const hl = (l.highlights?.[lang] || []).slice(0, 4);
  const para = firstPara(t(l.description, lang));
  if (para && !/PLACEHOLDER|مؤقت/.test(para)) lines.push(para);
  else if (hl.length) lines.push(hl.join(' · '));
  if (para && hl.length && !/PLACEHOLDER|مؤقت/.test(para)) lines.push(hl.join(' · '));
  lines.push('');
  lines.push(price(l.price, lang));
  lines.push(CTA[lang](l));
  lines.push(AD[lang]);
  return lines.join('\n');
}

// ---------- hand-written non-listing content ----------
const BRAND = {
  manifesto: {
    topic: { en: 'Launch manifesto — why "quietly"', ar: 'بيان الإطلاق — لماذا «بهدوء»' },
    en: `Bona.\n\nA private real-estate boutique in Jeddah for homes that were never meant to be seen by everyone. Villas, penthouses, waterfront and off-market residences — shown by appointment, sold with discretion.\n\nWe list asking prices, not estimates. We answer in Arabic and English. We are a REGA-licensed brokerage, FAL ${site.licences.fal}.\n\nExceptional homes, quietly.\nWhatsApp ${WA} · link in bio.`,
    ar: `بونا.\n\nبوتيك عقاري خاص في جدة للمنازل التي لم تُصمَّم لتُعرض على الجميع. فلل، بنتهاوس، واجهات بحرية وعقارات خارج السوق — المعاينة بموعد، والبيع بخصوصية.\n\nنعرض أسعار الطلب لا التقديرات. نجيب بالعربية والإنجليزية. وساطة مرخّصة من الهيئة العامة للعقار، رخصة فال ${site.licences.fal}.\n\nمنازل استثنائية، بهدوء.\nواتساب ${WA} · الرابط في البايو.`,
    alt: { en: 'Bona wordmark in serif on ivory with a thin champagne rule', ar: 'شعار بونا بخط سيريف على خلفية عاجية مع خط شامبانيا رفيع' },
    tags: [...H.core, ...H.brand.slice(0, 5), '#منازل_استثنائية', '#luxuryrealestatejeddah'],
  },
  districts: {
    topic: { en: 'Where we work — Jeddah districts', ar: 'أين نعمل — أحياء جدة' },
    en: `Where we work.\n\nAl Khalidiyah for the classic villa streets. North Obhur, Al Sheraa and Al Bandar for the creek and the new-build villas. Al Shati for the Corniche. Al Rawdah, Al Zahra and Al Salamah for penthouses and apartments close to everything. Durrat Al Arous for a private beach.\n\nBeyond Jeddah: Riyadh (Wadi Safar), Dubai, Muscat, the Côte d'Azur and Costa del Sol through partner brokerages.\n\nTell us the district; we'll tell you what's quietly available. WhatsApp ${WA}.`,
    ar: `أين نعمل.\n\nالخالدية لشوارع الفلل الكلاسيكية. أبحر الشمالية والشراع والبندر للخور والفلل الحديثة. الشاطئ للكورنيش. الروضة والزهراء والسلامة للبنتهاوس والشقق القريبة من كل شيء. درة العروس لشاطئ خاص.\n\nوخارج جدة: الرياض (وادي صفار)، دبي، مسقط، الريفييرا الفرنسية وكوستا ديل سول عبر شركاء وساطة.\n\nأخبرنا بالحي؛ ونخبرك بما هو متاح بهدوء. واتساب ${WA}.`,
    alt: { en: 'Exterior of a contemporary villa in Jeddah at dusk', ar: 'واجهة فيلا عصرية في جدة عند الغروب' },
    tags: [...H.core.slice(0, 6), '#الخالدية', '#أبحر', '#الشاطئ', '#الروضة', '#درة_العروس', '#alkhalidiyah', '#obhur', '#alshati', '#alrawdah', '#jeddahdistricts', '#bona'],
  },
  sell: {
    topic: { en: 'Sell with Bona — discreet marketing for owners', ar: 'بِع مع بونا — تسويق بخصوصية للمُلّاك' },
    en: `For owners who would rather not put their home on a portal.\n\nHow it works with Bona:\n1. A private visit and a frank conversation about price — the market's, not ours.\n2. Professional photography and a REGA-compliant listing.\n3. Introductions to a short list of qualified buyers before anything goes public.\n4. Negotiation, then transfer through Najiz — handled.\n\nOne conversation to start. WhatsApp ${WA} or the link in bio.`,
    ar: `للمُلّاك الذين يفضّلون ألا يظهر منزلهم على المنصات.\n\nكيف نعمل في بونا:\n1. زيارة خاصة وحديث صريح عن السعر — سعر السوق، لا رأينا.\n2. تصوير احترافي وإعلان متوافق مع أنظمة الهيئة العامة للعقار.\n3. عرض المنزل على قائمة قصيرة من المشترين الجادّين قبل أي نشر عام.\n4. التفاوض ثم نقل الملكية عبر ناجز — نتولّى ذلك.\n\nمحادثة واحدة للبدء. واتساب ${WA} أو الرابط في البايو.`,
    alt: { en: 'Living room interior with natural light in a Jeddah villa', ar: 'غرفة معيشة بإضاءة طبيعية في فيلا بجدة' },
    tags: [...H.core.slice(0, 6), '#بيع_عقار', '#تسويق_عقاري', '#بيع_فيلا', '#sellmyhome', '#offmarket', '#listwithus', '#homeselling', '#jeddahproperty', '#luxuryhomes', '#bona'],
  },
  welcome: {
    topic: { en: 'Launch announcement — Bona is open', ar: 'إعلان الإطلاق — بونا تفتح أبوابها' },
    en: `Bona is open.\n\nA private luxury real-estate boutique in Jeddah. Villas, penthouses, waterfront and off-market homes, shown by appointment.\n\nNine homes on the grid today; more arrive quietly every week. Save the ones you like, send us the reference number, and we'll take it from there.\n\nWhatsApp ${WA} · link in bio.`,
    ar: `بونا تفتح أبوابها.\n\nبوتيك عقاري فاخر خاص في جدة. فلل، بنتهاوس، واجهات بحرية وعقارات خارج السوق، المعاينة بموعد.\n\nتسعة منازل على الصفحة اليوم؛ والمزيد يصل بهدوء كل أسبوع. احفظ ما يعجبك، وأرسل لنا رقم المرجع، ونتولّى الباقي.\n\nواتساب ${WA} · الرابط في البايو.`,
    alt: { en: 'Hero view of a luxury villa in Jeddah', ar: 'لقطة رئيسية لفيلا فاخرة في جدة' },
    tags: [...H.core, ...H.villa.slice(0, 5), '#launch', '#افتتاح', '#bona'],
  },
};

const GUIDES = [
  { key: 'khalidiyah', match: /khalid/i, topic: { en: 'District guide — Al Khalidiyah', ar: 'دليل الحي — الخالدية' },
    en: `Al Khalidiyah, in five lines.\n\n1. Jeddah's original villa district — wide plots, mature trees, streets that were planned for families.\n2. Ten minutes to the Corniche, King Abdullah Road and the Red Sea Mall.\n3. Housing stock: classic 1990s–2000s villas being renovated, plus new-build contemporary villas on double plots.\n4. Who buys here: established Jeddah families and returning expats who want a house, not a compound.\n5. What to check: plot size on the deed (صك) versus the fence, and whether the street is on the municipality's re-paving list.\n\nWe have villas quietly available here. WhatsApp ${WA}.`,
    ar: `الخالدية، في خمسة أسطر.\n\n1. حي الفلل الأصلي في جدة — قطع واسعة، أشجار معمّرة، وشوارع خُطّطت للعائلات.\n2. عشر دقائق إلى الكورنيش وطريق الملك عبدالله ورد سي مول.\n3. المعروض: فلل كلاسيكية من التسعينيات والألفينيات تُجدَّد، وفلل عصرية جديدة على قطع مزدوجة.\n4. من يشتري هنا: عائلات جدة العريقة والعائدون من الخارج ممن يريدون بيتاً لا مجمّعاً.\n5. ما يجب التحقق منه: مساحة القطعة في الصك مقابل السور، وهل الشارع ضمن خطة الأمانة لإعادة السفلتة.\n\nلدينا فلل متاحة هنا بهدوء. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), '#الخالدية', '#حي_الخالدية', '#alkhalidiyah', '#khalidiyah', '#فلل_الخالدية', ...H.edu.slice(0, 4), '#jeddahdistricts', '#bona'] },
  { key: 'obhur', match: /obhur|abhur|sheraa|bandar|shera/i, topic: { en: 'District guide — North Obhur (Al Sheraa, Al Bandar)', ar: 'دليل الحي — أبحر الشمالية (الشراع، البندر)' },
    en: `North Obhur, in five lines.\n\n1. The creek (Sharm Obhur) is the point: water on one side, new villa streets on the other.\n2. Al Sheraa and Al Bandar are where most contemporary villas have been built in the last five years.\n3. Twenty-five minutes to the airport, thirty to the centre — you trade commute for sea.\n4. Who buys here: younger families, second-home owners, and buyers who want a pool and a boat slip.\n5. What to check: whether "sea view" is line-of-sight or across a plot that will be built on; the compound's HOA rules if inside one.\n\nVillas for sale and for rent quietly available. WhatsApp ${WA}.`,
    ar: `أبحر الشمالية، في خمسة أسطر.\n\n1. الخور (شرم أبحر) هو الجوهر: الماء من جهة، وشوارع فلل جديدة من الجهة الأخرى.\n2. الشراع والبندر حيث بُنيت معظم الفلل العصرية خلال السنوات الخمس الأخيرة.\n3. خمس وعشرون دقيقة إلى المطار، وثلاثون إلى وسط المدينة — تبادل المسافة بالبحر.\n4. من يشتري هنا: عائلات شابة، وأصحاب المنازل الثانية، ومن يريد مسبحاً ومرسى.\n5. ما يجب التحقق منه: هل «إطلالة البحر» مباشرة أم عبر قطعة ستُبنى لاحقاً؛ وأنظمة المجمّع إن كان داخل واحد.\n\nفلل للبيع وللإيجار متاحة بهدوء. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), '#أبحر', '#ابحر_الشمالية', '#الشراع', '#البندر', '#obhur', '#northobhur', ...H.water.slice(0, 3), ...H.edu.slice(0, 3), '#bona'] },
  { key: 'shati', match: /shati|corniche/i, topic: { en: 'District guide — Al Shati', ar: 'دليل الحي — الشاطئ' },
    en: `Al Shati, in five lines.\n\n1. The Corniche district: Jeddah's waterfront promenade is the front garden.\n2. Mix of large villas on the inner streets and high-end apartment towers along the seafront.\n3. Walking distance to the Corniche, the Formula 1 circuit precinct and Jeddah Yacht Club.\n4. Who buys here: buyers who want the sea without leaving the city; investors in serviced apartments.\n5. What to check: tower service charges and parking ratios; for villas, the age of the structure and any coastal-corrosion history.\n\nWhatsApp ${WA} for what's available.`,
    ar: `الشاطئ، في خمسة أسطر.\n\n1. حي الكورنيش: واجهة جدة البحرية هي الحديقة الأمامية.\n2. مزيج من الفلل الكبيرة في الشوارع الداخلية وأبراج شقق راقية على الواجهة.\n3. على مسافة مشي من الكورنيش ومنطقة حلبة الفورمولا 1 ونادي جدة لليخوت.\n4. من يشتري هنا: من يريد البحر دون مغادرة المدينة؛ ومستثمرو الشقق المخدومة.\n5. ما يجب التحقق منه: رسوم خدمات الأبراج ونسب المواقف؛ وللفلل، عمر المبنى وأي تاريخ لتآكل ساحلي.\n\nواتساب ${WA} لمعرفة المتاح.`,
    tags: [...H.core.slice(0, 6), '#الشاطئ', '#حي_الشاطئ', '#كورنيش_جدة', '#alshati', '#jeddahcorniche', ...H.water.slice(0, 3), ...H.edu.slice(0, 3), '#bona'] },
  { key: 'rawdah', match: /rawdah|zahra|salamah/i, topic: { en: 'District guide — Al Rawdah, Al Zahra & Al Salamah', ar: 'دليل الحي — الروضة والزهراء والسلامة' },
    en: `Al Rawdah, Al Zahra and Al Salamah, in five lines.\n\n1. The central triangle: Tahlia, Prince Sultan Road and Sari Street on your doorstep.\n2. Penthouses and large apartments dominate; a few older villas remain on the quieter streets.\n3. Everything is ten minutes away — schools, hospitals, Mall of Arabia, the Corniche.\n4. Who buys here: professionals, downsizers, families who want lock-and-leave.\n5. What to check: building age and lift maintenance; whether the roof rights come with a penthouse; owners' association (اتحاد الملاك) status.\n\nWe have penthouses and apartments quietly available. WhatsApp ${WA}.`,
    ar: `الروضة والزهراء والسلامة، في خمسة أسطر.\n\n1. المثلث المركزي: التحلية وطريق الأمير سلطان وشارع صاري على بابك.\n2. تهيمن البنتهاوس والشقق الكبيرة؛ وتبقى بعض الفلل القديمة في الشوارع الهادئة.\n3. كل شيء على بعد عشر دقائق — المدارس والمستشفيات ومول العرب والكورنيش.\n4. من يشتري هنا: المهنيون، ومن ينتقل إلى مساحة أصغر، والعائلات التي تريد بيتاً يُغلق ويُترك.\n5. ما يجب التحقق منه: عمر المبنى وصيانة المصاعد؛ وهل حقوق السطح مشمولة مع البنتهاوس؛ وحالة اتحاد الملاك.\n\nلدينا بنتهاوس وشقق متاحة بهدوء. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), '#الروضة', '#الزهراء', '#السلامة', '#alrawdah', '#alzahra', '#alsalamah', ...H.penthouse.slice(0, 4), ...H.edu.slice(0, 2), '#bona'] },
  { key: 'durrat', match: /durrat|arous/i, topic: { en: 'District guide — Durrat Al Arous', ar: 'دليل الحي — درة العروس' },
    en: `Durrat Al Arous, in five lines.\n\n1. A gated resort community 60 km north of Jeddah with private beaches, marinas and a golf course.\n2. Villas sit directly on the sand or on the lagoons — this is the "private beach" address in the Jeddah market.\n3. Weekend house for most owners; a handful live there year-round.\n4. Who buys here: families who want a second home an hour from the city, and buyers who want the beach without the resort crowd.\n5. What to check: community fees, beach-frontage rights on the plan, and the renovation age of the villa (salt air is unforgiving).\n\nA private-beach villa is quietly available. WhatsApp ${WA}.`,
    ar: `درة العروس، في خمسة أسطر.\n\n1. مجتمع منتجعي مسوّر على بعد 60 كم شمال جدة بشواطئ خاصة ومراسٍ وملعب غولف.\n2. الفلل تقع مباشرة على الرمل أو على البحيرات — هذا هو عنوان «الشاطئ الخاص» في سوق جدة.\n3. بيت نهاية الأسبوع لمعظم المُلّاك؛ وقلّة يقيمون فيه طوال العام.\n4. من يشتري هنا: عائلات تريد منزلاً ثانياً على بعد ساعة من المدينة، ومن يريد الشاطئ دون زحام المنتجعات.\n5. ما يجب التحقق منه: رسوم المجتمع، وحقوق الواجهة الشاطئية في المخطط، وعمر تجديد الفيلا (هواء البحر لا يرحم).\n\nفيلا بشاطئ خاص متاحة بهدوء. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), '#درة_العروس', '#durratalarous', '#فلل_على_البحر', '#شاطئ_خاص', ...H.water.slice(0, 5), ...H.edu.slice(0, 2), '#bona'] },
];

const EDU = [
  { topic: { en: 'Buying a villa in Jeddah — the 7 steps', ar: 'شراء فيلا في جدة — الخطوات السبع' },
    en: `How a villa purchase actually happens in Jeddah — seven steps, no surprises.\n\n1. Brief: district, size, budget range, timeline.\n2. Shortlist and private viewings (two visits: day and evening).\n3. Deed check — the صك is verified on Najiz: owner, area, boundaries, any mortgage.\n4. Offer and negotiation in writing.\n5. Sale agreement and deposit (typically held until transfer).\n6. Transfer at the Ministry of Justice e-service (Najiz) — same day when documents are ready; buyer pays the 5% real-estate transaction tax unless exempt.\n7. Keys, utilities transfer (SEC, water), and the ad-licence closed.\n\nQuestions on any step: WhatsApp ${WA}.`,
    ar: `كيف تتم عملية شراء فيلا في جدة فعلياً — سبع خطوات، بلا مفاجآت.\n\n1. التحديد: الحي، المساحة، نطاق الميزانية، الجدول الزمني.\n2. قائمة قصيرة ومعاينات خاصة (زيارتان: نهاراً ومساءً).\n3. فحص الصك — يُتحقق منه في ناجز: المالك، المساحة، الحدود، وأي رهن.\n4. عرض وتفاوض كتابياً.\n5. اتفاقية بيع وعربون (يُحفظ عادةً حتى نقل الملكية).\n6. نقل الملكية عبر خدمة وزارة العدل الإلكترونية (ناجز) — في اليوم نفسه عند اكتمال المستندات؛ يدفع المشتري ضريبة التصرفات العقارية 5% ما لم يكن معفى.\n7. المفاتيح، ونقل الخدمات (الكهرباء والمياه)، وإغلاق رخصة الإعلان.\n\nأسئلة عن أي خطوة: واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), ...H.edu, '#ناجز', '#صك', '#شراء_فيلا', '#homebuying', '#bona'] },
  { topic: { en: 'Off-market, explained', ar: 'خارج السوق — ما معناه' },
    en: `"Off-market" is not a mystery. It is a home the owner has agreed to sell, but not to advertise.\n\nWhy owners choose it: privacy, no strangers walking through, no price visible to neighbours, and a shorter list of serious buyers.\n\nWhy buyers like it: less competition, and a conversation that starts with facts rather than a portal photo.\n\nHow it works at Bona: the owner briefs us, we prepare the file (deed, plans, photography), and we introduce the home to a handful of qualified buyers under a short NDA. If it doesn't sell that way, it goes public — properly licensed.\n\nIf you own something you'd rather sell this way: WhatsApp ${WA}.`,
    ar: `«خارج السوق» ليس لغزاً. هو منزل وافق مالكه على بيعه، لا على الإعلان عنه.\n\nلماذا يختاره المُلّاك: الخصوصية، لا غرباء يتجوّلون في البيت، لا سعر ظاهر للجيران، وقائمة أقصر من المشترين الجادّين.\n\nولماذا يفضّله المشترون: منافسة أقل، وحديث يبدأ بالحقائق لا بصورة على منصة.\n\nكيف يتم في بونا: يزوّدنا المالك بالمعلومات، نُعدّ الملف (الصك، المخططات، التصوير)، ونعرض المنزل على عدد محدود من المشترين الجادّين تحت اتفاقية سرّية مختصرة. وإن لم يُبع بهذه الطريقة، يُعرض علناً — بترخيص نظامي.\n\nإن كنت تملك ما تفضّل بيعه بهذه الطريقة: واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), '#خارج_السوق', '#بيع_عقار', '#offmarket', '#discreetsale', '#sellmyhome', ...H.edu.slice(0, 4), '#bona'] },
  { topic: { en: 'Off-plan: 6 things to check before you reserve', ar: 'على الخارطة: 6 أمور تحقّق منها قبل الحجز' },
    en: `Before you reserve an off-plan villa or apartment in Saudi Arabia, check six things:\n\n1. Wafi licence number for the project (the developer must show it).\n2. Escrow account — your payments should go to the project's escrow, not the developer's operating account.\n3. Delivery date and the penalty clause if it slips.\n4. Exactly what "finishing" includes: kitchen, AC, wardrobes, landscaping.\n5. Service charges after handover, in writing.\n6. Resale rules — can you assign the contract before completion, and at what fee?\n\nWe only present projects that pass all six. WhatsApp ${WA}.`,
    ar: `قبل أن تحجز فيلا أو شقة على الخارطة في السعودية، تحقّق من ستة أمور:\n\n1. رقم ترخيص وافي للمشروع (يجب أن يُظهره المطوّر).\n2. حساب الضمان — يجب أن تذهب دفعاتك إلى حساب ضمان المشروع لا الحساب التشغيلي للمطوّر.\n3. موعد التسليم وبند الغرامة عند التأخير.\n4. ما الذي يشمله «التشطيب» بالضبط: المطبخ، التكييف، الخزائن، التنسيق الخارجي.\n5. رسوم الخدمات بعد التسليم، كتابياً.\n6. قواعد إعادة البيع — هل يمكنك التنازل عن العقد قبل الإنجاز، وبأي رسوم؟\n\nنعرض فقط المشاريع التي تجتاز الستة. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), '#على_الخارطة', '#وافي', '#offplan', '#offplanjeddah', '#newdevelopment', ...H.edu.slice(0, 4), '#bona'] },
  { topic: { en: 'Luxury rentals — Ejar contracts in plain language', ar: 'الإيجارات الفاخرة — عقود إيجار بلغة بسيطة' },
    en: `Renting a villa in Jeddah? Three things about Ejar, the national rental platform:\n\n1. Every residential lease must be registered on Ejar; an unregistered lease is hard to enforce for both sides.\n2. The contract fixes rent, payment schedule, maintenance split, and who pays the Ejar fee — read the maintenance clause twice.\n3. Renewal and exit terms are what people argue about later: notice period, deposit return timeline, and the state you must return the villa in.\n\nWe handle registration for our tenants and owners. WhatsApp ${WA}.`,
    ar: `تستأجر فيلا في جدة؟ ثلاثة أمور عن «إيجار»، المنصة الوطنية للإيجار:\n\n1. كل عقد إيجار سكني يجب أن يُوثَّق في إيجار؛ العقد غير الموثّق يصعب تنفيذه للطرفين.\n2. العقد يحدّد الإيجار، وجدول الدفع، وتوزيع الصيانة، ومن يدفع رسوم المنصة — اقرأ بند الصيانة مرتين.\n3. شروط التجديد والإخلاء هي ما يختلف عليه الناس لاحقاً: مدة الإشعار، وموعد إعادة التأمين، والحالة التي يجب أن تُعاد بها الفيلا.\n\nنتولّى التوثيق لمستأجرينا ومُلّاكنا. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), '#ايجار', '#فلل_للإيجار_جدة', '#عقد_إيجار', '#jeddahrentals', '#villaforrent', ...H.edu.slice(0, 4), '#bona'] },
];

const INSIGHT = [
  { topic: { en: 'What "waterfront" means in Jeddah — creek, Corniche or private beach', ar: 'ماذا تعني «الواجهة البحرية» في جدة — الخور أم الكورنيش أم الشاطئ الخاص' },
    en: `"Waterfront" means three different things in Jeddah.\n\nThe creek (Sharm Obhur, North Obhur): calm water, boat access, villa streets, 25 minutes from the centre.\nThe Corniche (Al Shati, Al Hamra): open sea, promenade, towers and older villas, in the city.\nThe private beach (Durrat Al Arous, Al Murjan communities): sand at the garden gate, gated, an hour out.\n\nThey suit different lives — and they are priced differently for reasons that have nothing to do with square metres. Ask us which one fits yours. WhatsApp ${WA}.`,
    ar: `«الواجهة البحرية» تعني ثلاثة أشياء مختلفة في جدة.\n\nالخور (شرم أبحر، أبحر الشمالية): مياه هادئة، ومرسى للقوارب، وشوارع فلل، على بعد 25 دقيقة من الوسط.\nالكورنيش (الشاطئ، الحمراء): بحر مفتوح، وممشى، وأبراج وفلل أقدم، داخل المدينة.\nالشاطئ الخاص (درة العروس، مجتمعات المرجان): الرمل عند بوابة الحديقة، مسوّر، على بعد ساعة.\n\nتناسب أنماط حياة مختلفة — وتُسعَّر بشكل مختلف لأسباب لا علاقة لها بالأمتار المربعة. اسألنا أيها يناسبك. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), ...H.water, '#أبحر', '#الشاطئ', '#درة_العروس', '#jeddahlife', '#bona'] },
  { topic: { en: 'Villa or apartment in Jeddah — a lifestyle comparison, not a price one', ar: 'فيلا أم شقة في جدة — مقارنة أسلوب حياة لا سعر' },
    en: `Villa or apartment? The honest comparison, price aside.\n\nVilla: privacy, garden, majlis for guests, parking for four; you own the maintenance, the roof and the water tank.\nApartment/penthouse: lock-and-leave, lift, security desk, a view from the 20th floor; you share the building's decisions and its service charge.\n\nFamilies with drivers and staff quarters lean villa. Couples and frequent travellers lean penthouse. Neither is "the better investment" — that depends on the building, the street and the deed, and we'll say so in person. WhatsApp ${WA}.`,
    ar: `فيلا أم شقة؟ المقارنة الصادقة، بعيداً عن السعر.\n\nالفيلا: خصوصية، وحديقة، ومجلس للضيوف، ومواقف لأربع سيارات؛ وتتحمّل أنت الصيانة والسطح وخزان المياه.\nالشقة/البنتهاوس: تُغلق وتُترك، مصعد، أمن، وإطلالة من الدور العشرين؛ وتشارك قرارات المبنى ورسوم خدماته.\n\nالعائلات مع سائقين وغرف خدم تميل إلى الفيلا. الأزواج وكثيرو السفر يميلون إلى البنتهاوس. لا أحدهما «الاستثمار الأفضل» — ذلك يعتمد على المبنى والشارع والصك، وسنقول ذلك بصراحة عند اللقاء. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), ...H.villa.slice(0, 3), ...H.penthouse.slice(0, 3), ...H.edu.slice(0, 4), '#bona'] },
  { topic: { en: 'Reading a Saudi title deed (صك) — the five lines that matter', ar: 'قراءة الصك العقاري — الأسطر الخمسة المهمة' },
    en: `Five lines to read on any Saudi title deed (صك) before you fall in love with the house:\n\n1. Owner name — matches the seller's ID exactly?\n2. Area — in m², and does it match what you paced?\n3. Boundaries — the four sides and their lengths; compare with the fence.\n4. Restrictions — any mortgage, lien or "حجز" noted.\n5. Deed number and date — verify it live on Najiz, not from a photo.\n\nWe do this before the first viewing, every time. WhatsApp ${WA}.`,
    ar: `خمسة أسطر اقرأها في أي صك عقاري قبل أن تتعلّق بالبيت:\n\n1. اسم المالك — يطابق هوية البائع تماماً؟\n2. المساحة — بالمتر المربع، وهل تطابق ما قِسته؟\n3. الحدود — الجهات الأربع وأطوالها؛ قارنها بالسور.\n4. القيود — أي رهن أو حجز مدوّن.\n5. رقم الصك وتاريخه — تحقّق منه مباشرة في ناجز، لا من صورة.\n\nنفعل هذا قبل المعاينة الأولى، في كل مرة. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), '#صك', '#ناجز', '#صك_عقاري', ...H.edu, '#bona'] },
];

const NATIONAL_DAY = {
  topic: { en: 'Saudi National Day 96', ar: 'اليوم الوطني السعودي 96' },
  en: `Ninety-six years of a home called Saudi Arabia.\n\nFrom all of us at Bona — happy National Day. The office is closed today; we're back Thursday.\n\n#اليوم_الوطني_96 #هي_لنا_دار`,
  ar: `ستة وتسعون عاماً لوطنٍ اسمه السعودية.\n\nمن جميعنا في بونا — كل عام ووطننا بخير. المكتب مغلق اليوم؛ ونعود الخميس.\n\n#اليوم_الوطني_96 #هي_لنا_دار`,
  tags: ['#اليوم_الوطني', '#اليوم_الوطني_السعودي_96', '#هي_لنا_دار', '#SaudiNationalDay', '#KSA96', '#بونا', '#جدة', '#السعودية', '#bona', '#jeddah', '#saudiarabia'],
};

const BEHIND = [
  { topic: { en: 'Behind the house — shoot day', ar: 'خلف الكواليس — يوم التصوير' },
    en: `Behind the house.\n\nA shoot day starts at 6:40 — the only hour the light in a Jeddah garden is soft. We open every curtain, move the cars, and photograph the rooms in the order a buyer walks them. No wide-angle tricks; what you see is the room.\n\nThe result goes to owners first, then to the grid. WhatsApp ${WA}.`,
    ar: `خلف الكواليس.\n\nيوم التصوير يبدأ في 6:40 — الساعة الوحيدة التي يكون فيها الضوء في حديقة جدة ناعماً. نفتح كل الستائر، ونحرّك السيارات، ونصوّر الغرف بالترتيب الذي يمشيه المشتري. لا حيل بالعدسات الواسعة؛ ما تراه هو الغرفة.\n\nالنتيجة تذهب إلى المُلّاك أولاً، ثم إلى الصفحة. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), ...H.brand, '#behindthescenes', '#realestatephotography', '#bona'] },
  { topic: { en: 'Behind the house — the viewing', ar: 'خلف الكواليس — المعاينة' },
    en: `Behind the house: the viewing.\n\nWe do two. The first in daylight, for the rooms and the garden. The second after sunset, for the street, the neighbours, the traffic, the call to prayer from the nearest mosque. A house you'll live in should be seen at the hours you'll live in it.\n\nBy appointment, Sunday to Thursday. WhatsApp ${WA}.`,
    ar: `خلف الكواليس: المعاينة.\n\nنجري معاينتين. الأولى في النهار، للغرف والحديقة. والثانية بعد الغروب، للشارع والجيران والحركة وصوت الأذان من أقرب مسجد. البيت الذي ستسكنه يجب أن تراه في الساعات التي ستعيشها فيه.\n\nبموعد، من الأحد إلى الخميس. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), ...H.brand.slice(0, 5), '#viewing', '#معاينة', '#jeddahlife', '#bona'] },
  { topic: { en: 'Behind the house — what we say no to', ar: 'خلف الكواليس — ما نرفضه' },
    en: `Behind the house: what we say no to.\n\nNo valuations — we're brokers, not TAQEEM valuers; we quote the owner's asking price and the recent, verifiable transactions.\nNo "prices will rise" posts.\nNo listing without a deed check and a REGA ad licence.\nNo photos of a home the owner hasn't approved.\n\nIt makes for a slower feed and a better sale. WhatsApp ${WA}.`,
    ar: `خلف الكواليس: ما نرفضه.\n\nلا تقييمات — نحن وسطاء لا مقيّمين معتمدين من تقييم؛ نذكر سعر طلب المالك والصفقات الحديثة القابلة للتحقق.\nلا منشورات «الأسعار سترتفع».\nلا إعلان دون فحص الصك ورخصة إعلان من الهيئة العامة للعقار.\nلا صور لمنزل لم يوافق مالكه عليها.\n\nيصنع ذلك صفحة أبطأ وبيعاً أفضل. واتساب ${WA}.`,
    tags: [...H.core.slice(0, 6), ...H.brand.slice(0, 4), '#الهيئة_العامة_للعقار', '#رخصة_فال', '#ethics', '#bona'] },
];

const STORIES = [
  { en: 'Launch day: 9 homes on the grid. Swipe up → link in bio.', ar: 'يوم الإطلاق: 9 منازل على الصفحة. الرابط في البايو.' },
  { en: 'Poll: villa or penthouse?', ar: 'استطلاع: فيلا أم بنتهاوس؟' },
  { en: 'One room, one listing: the majlis. Ref. in the sticker.', ar: 'غرفة واحدة، عقار واحد: المجلس. المرجع في الملصق.' },
  { en: 'Question box: which Jeddah district should we guide next?', ar: 'صندوق الأسئلة: أي حي في جدة نكتب عنه بعد ذلك؟' },
  { en: 'New this week — quietly. Two homes, one district. Ask for refs.', ar: 'جديد هذا الأسبوع — بهدوء. منزلان، حي واحد. اطلب المراجع.' },
  { en: 'Weekend: a garden at 6:40 am. That\'s all.', ar: 'نهاية الأسبوع: حديقة في 6:40 صباحاً. هذا كل شيء.' },
  { en: 'Weekend: the Corniche from the 18th floor.', ar: 'نهاية الأسبوع: الكورنيش من الدور الثامن عشر.' },
  { en: 'Office open. Sun–Thu 10–19. WhatsApp sticker.', ar: 'المكتب مفتوح. الأحد–الخميس 10–19. ملصق واتساب.' },
  { en: 'Quiz: how many m² is this living room? Answer tomorrow.', ar: 'اختبار: كم متراً مربعاً هذه الصالة؟ الجواب غداً.' },
  { en: 'Answer to yesterday\'s quiz + the listing link.', ar: 'جواب اختبار الأمس + رابط العقار.' },
  { en: 'Viewing day. Two homes, one street. No faces, no addresses.', ar: 'يوم المعاينات. منزلان، شارع واحد. بلا وجوه، بلا عناوين.' },
  { en: '"Is it still available?" — the 3 most-asked refs this week.', ar: '«هل ما زال متاحاً؟» — أكثر 3 مراجع سُئل عنها هذا الأسبوع.' },
  { en: 'Weekend: pool at dusk, North Obhur.', ar: 'نهاية الأسبوع: مسبح عند الغروب، أبحر الشمالية.' },
  { en: 'Weekend: reading corner, Al Khalidiyah villa.', ar: 'نهاية الأسبوع: ركن القراءة، فيلا في الخالدية.' },
  { en: 'Owners: 3 things we need to start marketing your home (deed, plans, photos). DM us.', ar: 'للمُلّاك: 3 أشياء نحتاجها لبدء تسويق منزلك (الصك، المخططات، الصور). راسلنا.' },
  { en: 'Poll: creek, Corniche or private beach?', ar: 'استطلاع: الخور أم الكورنيش أم الشاطئ الخاص؟' },
  { en: 'National Day eve: the flag on a Jeddah balcony.', ar: 'ليلة اليوم الوطني: العلم على شرفة في جدة.' },
  { en: 'National Day — office closed. Back Thursday.', ar: 'اليوم الوطني — المكتب مغلق. نعود الخميس.' },
  { en: 'Back in the office. New ref added — ask.', ar: 'عدنا إلى المكتب. مرجع جديد أُضيف — اسأل.' },
  { en: 'Weekend: a kitchen nobody has cooked in yet (off-plan handover).', ar: 'نهاية الأسبوع: مطبخ لم يطبخ فيه أحد بعد (تسليم على الخارطة).' },
  { en: 'Weekend: the light in the stairwell.', ar: 'نهاية الأسبوع: الضوء في بئر الدرج.' },
  { en: 'Question box: ask us anything about buying in Jeddah. We answer in stories tomorrow.', ar: 'صندوق الأسئلة: اسألنا أي شيء عن الشراء في جدة. نجيب في القصص غداً.' },
  { en: 'Answers to your questions (part 1).', ar: 'إجابات أسئلتكم (الجزء الأول).' },
  { en: 'Answers to your questions (part 2).', ar: 'إجابات أسئلتكم (الجزء الثاني).' },
  { en: 'Under offer: one of the launch homes. Ref hidden; 8 remain.', ar: 'قيد التفاوض: أحد منازل الإطلاق. المرجع محجوب؛ يبقى 8.' },
  { en: 'Weekend: the sea from a Durrat Al Arous terrace.', ar: 'نهاية الأسبوع: البحر من شرفة في درة العروس.' },
  { en: 'Weekend: a majlis set for twelve.', ar: 'نهاية الأسبوع: مجلس مهيّأ لاثني عشر ضيفاً.' },
  { en: 'Month one, thank you. What you asked for most: North Obhur villas. Noted.', ar: 'الشهر الأول، شكراً. أكثر ما طلبتموه: فلل أبحر الشمالية. سُجّل.' },
  { en: 'Poll: next district guide — Al Mohammadiyah or Al Andalus?', ar: 'استطلاع: دليل الحي القادم — المحمدية أم الأندلس؟' },
  { en: 'New week, new refs. Link in bio.', ar: 'أسبوع جديد، مراجع جديدة. الرابط في البايو.' },
];

// ---------- 3D tours & project units (round 2) ----------
const tourOf = (l) => { const u = String(l.virtualTourUrl ?? '').trim(); return /^https?:\/\//i.test(u) ? u : null; };
const tourPool = live.filter(tourOf);
const TOURS_URL = `${base}/tours/`;
const TOUR_STORIES = [
  { en: (l) => `Walk through it before you visit — 3D tour of ${t(l.title, 'en')}. Link sticker → tour. Ref. ${l.id}`, ar: (l) => `تجوّل فيه قبل الزيارة — جولة ثلاثية الأبعاد في ${t(l.title, 'ar')}. ملصق الرابط ← الجولة. المرجع ${l.id}` },
  { en: (l) => `Tap, turn, walk: ${t(l.title, 'en')} in 3D. Which room would you change first?`, ar: (l) => `اضغط، أدِر، امشِ: ${t(l.title, 'ar')} بتقنية ثلاثية الأبعاد. أي غرفة ستغيّرها أولاً؟` },
  { en: (l) => `Same home, no traffic. The Matterport tour of ${t(l.title, 'en')} — link sticker.`, ar: (l) => `المنزل نفسه، بلا زحام. جولة Matterport في ${t(l.title, 'ar')} — ملصق الرابط.` },
  { en: () => 'Poll: have you tried a 3D tour yet? Yes / Show me one', ar: () => 'استطلاع: جرّبت جولة ثلاثية الأبعاد من قبل؟ نعم / أرِني واحدة' },
  { en: (l) => `Measure it yourself — the 3D tour has a measuring tool. ${t(l.title, 'en')}, ref. ${l.id}.`, ar: (l) => `قِسها بنفسك — الجولة ثلاثية الأبعاد فيها أداة قياس. ${t(l.title, 'ar')}، المرجع ${l.id}.` },
  { en: () => `All our 3D tours in one place → ${TOURS_URL}`, ar: () => `كل جولاتنا ثلاثية الأبعاد في مكان واحد ← ${TOURS_URL}` },
];
let tsi = 0;
function tourStory(date) {
  if (!tourPool.length) return null;
  const l = tourPool[tsi % tourPool.length];
  const st = TOUR_STORIES[tsi % TOUR_STORIES.length];
  tsi++;
  return { date, platform: 'instagram', format: 'story', pillar: 'listings', topic: { en: `3D tour story — ${t(l.title, 'en')}`, ar: `قصة جولة ثلاثية الأبعاد — ${t(l.title, 'ar')}` }, caption: { en: st.en(l), ar: st.ar(l) }, hashtags: [], image: l.images?.[1]?.src || heroOf(l), listingId: l.id, url: tourOf(l), tourUrl: tourOf(l), adLicenceRequired: false, status: 'planned' };
}
function tourCaption(l, lang) {
  const ar = lang === 'ar';
  const lines = [ar ? 'تجوّل قبل أن تزور.' : 'Walk through it before you visit.', t(l.title, lang), `${t(l.location.district, lang)}${ar ? '،' : ','} ${t(l.location.city, lang)}`];
  const sp = spec(l, lang); if (sp) lines.push(sp);
  lines.push('', ar ? 'جولة Matterport ثلاثية الأبعاد: كل غرفة بزاويتها الحقيقية، مع أداة قياس. الرابط في البايو ← «الجولات».' : 'A Matterport 3D tour: every room at its true angle, with a measuring tool. Link in bio → “Tours”.', ar ? 'ثم نرتّب المعاينة الخاصة.' : 'Then we arrange the private viewing.', '', price(l.price, lang), CTA[lang](l), AD[lang]);
  return lines.join('\n');
}
const tourReel = (l) => ({ format: 'reel', pillar: 'listings', topic: { en: `3D tour — ${t(l.title, 'en')}`, ar: `جولة ثلاثية الأبعاد — ${t(l.title, 'ar')}` }, caption: { en: tourCaption(l, 'en'), ar: tourCaption(l, 'ar') }, hashtags: uniq([...tagsFor(l).slice(0, 14), '#3dtour', '#virtualtour', '#matterport', '#جولة_افتراضية', '#جولة_ثلاثية_الأبعاد']).slice(0, 20), image: heroOf(l), images: [heroOf(l)], alt: { en: altOf(l, 'en'), ar: altOf(l, 'ar') }, listingId: l.id, url: url(l, 'en'), tourUrl: tourOf(l), note: 'Screen-record the Matterport walkthrough (15–30 s, 9:16, captions on, ambient audio only); end card = listing hero + ref.', adLicenceRequired: true });

// Project units (e.g. Kian Residence): grouped by `project.name`; falls back to the title while the data agent back-fills `project`.
const projectKey = (l) => (l.project?.name?.en || l.project?.name?.ar || '').trim() || (/k(i|ay)an\s+residence/i.test(t(l.title, 'en')) ? 'Kian Residence' : '');
const projects = (() => { const m = new Map(); for (const l of live) { const k = projectKey(l); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(l); } return [...m.entries()].map(([name, units]) => ({ name, units })); })();
const projectNameAr = (p) => p.units[0].project?.name?.ar || (p.name === 'Kian Residence' ? 'كيان ريزيدنس' : (t(p.units[0].title, 'ar').split('،')[0] || p.name));
const unitLine = (l, lang) => {
  const ar = lang === 'ar'; const u = l.unit || {}; const bits = [];
  bits.push(u.unitRef ? (ar ? `وحدة ${u.unitRef}` : `Unit ${u.unitRef}`) : t(l.title, lang));
  if (u.floor != null && u.floor !== '') bits.push(ar ? `الدور ${u.floor}` : `floor ${u.floor}`);
  if (l.specs?.beds) bits.push(ar ? `${l.specs.beds} غرف` : `${l.specs.beds} bed`);
  if (l.specs?.areaSqm) bits.push(`${l.specs.areaSqm} ${ar ? 'م²' : 'm²'}`);
  bits.push(price(l.price, lang));
  if (tourOf(l)) bits.push(ar ? 'جولة ثلاثية الأبعاد' : '3D tour');
  return `• ${bits.join(' · ')}`;
};
function projectCaption(p, lang) {
  const ar = lang === 'ar'; const first = p.units[0]; const name = ar ? projectNameAr(p) : p.name;
  const lines = [ar ? `داخل ${name}، ${t(first.location.district, 'ar')} — الوحدات.` : `Inside ${name}, ${t(first.location.district, 'en')} — the units.`, ''];
  p.units.slice(0, 8).forEach((u) => lines.push(unitLine(u, lang)));
  lines.push('');
  const para = firstPara(t(first.description, lang)); if (para && !/PLACEHOLDER|مؤقت/.test(para)) lines.push(para);
  const dev = first.project?.developer?.[lang] || first.project?.developer?.en; if (dev) lines.push(ar ? `المطوّر: ${dev}` : `Developer: ${dev}`);
  lines.push('', ar ? `المراجع ${p.units.map((u) => u.id).join('، ')} — واتساب ${WA} أو الرابط في البايو.` : `Refs ${p.units.map((u) => u.id).join(', ')} — WhatsApp ${WA} or the link in bio.`, AD[lang]);
  return lines.join('\n');
}
const projectPost = (p) => { const first = p.units[0]; const images = uniq(p.units.flatMap((u) => imgs(u, 3))).slice(0, 8); return { format: 'carousel', pillar: 'listings', topic: { en: `Inside ${p.name} — the units`, ar: `داخل ${projectNameAr(p)} — الوحدات` }, caption: { en: projectCaption(p, 'en'), ar: projectCaption(p, 'ar') }, hashtags: uniq([...tagsFor(first).slice(0, 15), '#مشاريع_جدة', '#وحدات_سكنية', '#newdevelopment', '#offplan']).slice(0, 20), image: heroOf(first), images: images.length ? images : [heroOf(first)], alt: { en: altOf(first, 'en'), ar: altOf(first, 'ar') }, listingId: first.id, listingIds: p.units.map((u) => u.id), url: url(first, 'en'), adLicenceRequired: true }; };
let pi = 0, tri = 0;

// ---------- listing pools ----------
const score = (l) => (l.featured ? 100 : 0) + (l.images?.length || 0) * 2 + (l.price?.amount ? Math.log10(l.price.amount) : 0) + (l.category === 'buy' ? 5 : 0);
const pool = [...live].sort((a, b) => score(b) - score(a));
let cursor = 0;
const nextListing = () => (pool.length ? pool[cursor++ % pool.length] : null);
const findListing = (re) => pool.find((l) => re.test(`${t(l.location.district, 'en')} ${t(l.title, 'en')} ${t(l.location.city, 'en')}`));

// ---------- launch grid ----------
const launchListings = [];
for (let i = 0; i < 6; i++) { const l = nextListing(); if (l) launchListings.push(l); }
const LL = (i) => launchListings[i % Math.max(1, launchListings.length)] || null;
const launch = [
  { n: 1, grid: 'bottom-right', kind: 'listing', listing: LL(0), format: 'carousel' },
  { n: 2, grid: 'bottom-centre', kind: 'listing', listing: LL(1), format: 'post' },
  { n: 3, grid: 'bottom-left', kind: 'listing', listing: LL(2), format: 'carousel' },
  { n: 4, grid: 'middle-right', kind: 'districts', listing: LL(3) },
  { n: 5, grid: 'centre', kind: 'manifesto' },
  { n: 6, grid: 'middle-left', kind: 'listing', listing: LL(3), format: 'carousel' },
  { n: 7, grid: 'top-right', kind: 'listing', listing: LL(4), format: 'post' },
  { n: 8, grid: 'top-centre', kind: 'sell', listing: LL(1) },
  { n: 9, grid: 'top-left', kind: 'welcome', listing: LL(5) || LL(0) },
];
const launchItems = launch.map((p, i) => {
  if (p.kind === 'listing' && p.listing) {
    const l = p.listing;
    return { date: START, platform: 'instagram', format: p.format, pillar: 'listings', launch: p.n, grid: p.grid,
      topic: { en: `Launch #${p.n} — ${t(l.title, 'en')}`, ar: `الإطلاق #${p.n} — ${t(l.title, 'ar')}` },
      caption: { en: listingCaption(l, 'en', i), ar: listingCaption(l, 'ar', i) },
      hashtags: tagsFor(l), image: heroOf(l), images: p.format === 'carousel' ? imgs(l, 6) : [heroOf(l)],
      alt: { en: altOf(l, 'en'), ar: altOf(l, 'ar') }, listingId: l.id, url: url(l, 'en'), adLicenceRequired: true, status: 'planned' };
  }
  const b = BRAND[p.kind === 'listing' ? 'welcome' : p.kind];
  const img = p.kind === 'manifesto' ? OG : p.listing ? (p.kind === 'sell' ? (p.listing.images?.[1]?.src || heroOf(p.listing)) : heroOf(p.listing)) : OG;
  return { date: START, platform: 'instagram', format: p.kind === 'manifesto' ? 'post' : 'post', pillar: p.kind === 'sell' ? 'buyer/seller education' : 'behind the house', launch: p.n, grid: p.grid,
    topic: b.topic, caption: { en: b.en, ar: b.ar }, hashtags: uniq(b.tags).slice(0, 20), image: img, images: [img],
    alt: b.alt, listingId: p.listing?.id ?? null, url: `${base}/${p.kind === 'sell' ? 'sell/' : p.kind === 'districts' ? 'properties/' : ''}`, adLicenceRequired: false, status: 'planned' };
});

// ---------- 30-day calendar ----------
const d0 = new Date(`${START}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(d0); d.setUTCDate(d.getUTCDate() + n); return d; };
const dow = (d) => d.getUTCDay(); // 0 Sun … 6 Sat
const items = [...launchItems];
let gi = 0, ei = 0, ii = 0, bi = 0, li = 0, si = 0;
for (let n = 0; n < DAYS; n++) {
  const d = addDays(n);
  const date = iso(d);
  const w = dow(d);
  // daily story
  const st = STORIES[si++ % STORIES.length];
  items.push({ date, platform: 'instagram', format: 'story', pillar: w === 5 || w === 6 ? 'behind the house' : 'listings', topic: st, caption: st, hashtags: [], image: (pool[n % Math.max(1, pool.length)] ? heroOf(pool[n % pool.length]) : OG), adLicenceRequired: false, status: 'planned' });
  if (n > 0 && n % 5 === 2) { const ts = tourStory(date); if (ts) items.push(ts); } // 3D-tour story every ~5 days
  if (n === 0) continue; // launch day feed = the 9 grid posts
  if (w === 5 || w === 6) continue; // Fri/Sat: stories only
  if (date === '2026-09-23') {
    items.push({ date, platform: 'instagram', format: 'post', pillar: 'behind the house', topic: NATIONAL_DAY.topic, caption: { en: NATIONAL_DAY.en, ar: NATIONAL_DAY.ar }, hashtags: NATIONAL_DAY.tags, image: OG, alt: { en: 'Bona wordmark on ivory', ar: 'شعار بونا على خلفية عاجية' }, adLicenceRequired: false, status: 'planned' });
    continue;
  }
  let it;
  if (w === 0 && projects.length && n >= 7 && Math.floor(n / 7) % 2 === 1) { // alternate Sundays: project units carousel
    it = projectPost(projects[pi++ % projects.length]);
  } else if (w === 4 && tourPool.length && n >= 7 && Math.floor(n / 7) % 2 === 1 && tri < tourPool.length) { // alternate Thursdays: 3D-tour reel
    it = tourReel(tourPool[tri++]);
  } else if (w === 0 || w === 4) { // Sun / Thu: listing
    const l = nextListing();
    if (l) {
      const fmt = w === 0 ? 'carousel' : 'reel';
      it = { format: fmt, pillar: 'listings', topic: { en: t(l.title, 'en'), ar: t(l.title, 'ar') }, caption: { en: listingCaption(l, 'en', li), ar: listingCaption(l, 'ar', li) }, hashtags: tagsFor(l), image: heroOf(l), images: fmt === 'carousel' ? imgs(l, 6) : [heroOf(l)], alt: { en: altOf(l, 'en'), ar: altOf(l, 'ar') }, listingId: l.id, url: url(l, 'en'), adLicenceRequired: true };
      li++;
    }
  } else if (w === 1) { // Mon: district guide
    const g = GUIDES[gi++ % GUIDES.length];
    const l = findListing(g.match) || pool[gi % Math.max(1, pool.length)];
    it = { format: 'carousel', pillar: 'Jeddah district guides', topic: g.topic, caption: { en: g.en, ar: g.ar }, hashtags: uniq(g.tags).slice(0, 20), image: l ? heroOf(l) : OG, images: l ? imgs(l, 3) : [OG], alt: { en: `Street and villa in ${g.topic.en.replace('District guide — ', '')}`, ar: `شارع وفيلا في ${g.topic.ar.replace('دليل الحي — ', '')}` }, listingId: l?.id ?? null, url: `${base}/properties/`, adLicenceRequired: false };
  } else if (w === 2) { // Tue: education
    const e = EDU[ei++ % EDU.length];
    const l = pool[(ei + 2) % Math.max(1, pool.length)];
    it = { format: 'carousel', pillar: 'buyer/seller education', topic: e.topic, caption: { en: e.en, ar: e.ar }, hashtags: uniq(e.tags).slice(0, 20), image: l ? (l.images?.[2]?.src || heroOf(l)) : OG, images: [l ? (l.images?.[2]?.src || heroOf(l)) : OG], alt: { en: 'Interior detail used as a text-card background', ar: 'تفصيل داخلي كخلفية لبطاقة نصية' }, listingId: null, url: `${base}/about/`, adLicenceRequired: false };
  } else if (w === 3) { // Wed: insight / behind the house alternating
    const useInsight = (ii + bi) % 2 === 0;
    const src = useInsight ? INSIGHT[ii++ % INSIGHT.length] : BEHIND[bi++ % BEHIND.length];
    const l = pool[(ii + bi + 4) % Math.max(1, pool.length)];
    it = { format: useInsight ? 'post' : 'reel', pillar: useInsight ? 'market insight' : 'behind the house', topic: src.topic, caption: { en: src.en, ar: src.ar }, hashtags: uniq(src.tags).slice(0, 20), image: l ? (l.images?.[1]?.src || heroOf(l)) : OG, images: [l ? (l.images?.[1]?.src || heroOf(l)) : OG], alt: { en: 'Room interior in a Bona listing', ar: 'غرفة داخلية في أحد عقارات بونا' }, listingId: null, url: `${base}/`, adLicenceRequired: false };
  }
  if (it) items.push({ date, platform: 'instagram', ...it, status: 'planned' });
}

// sort: date, then feed posts before stories
const fmtOrder = { post: 0, carousel: 0, reel: 0, story: 1 };
items.sort((a, b) => a.date.localeCompare(b.date) || (fmtOrder[a.format] - fmtOrder[b.format]) || ((a.launch ?? 99) - (b.launch ?? 99)));

// ---------- outputs ----------
fs.writeFileSync(path.join(root, 'src/data/content-calendar.json'), JSON.stringify(items, null, 2) + '\n');

const weekday = (s) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${s}T00:00:00Z`).getUTCDay()];
const md = [];
md.push(`# Content calendar — Instagram @bona.com.sa (${START} → ${iso(addDays(DAYS - 1))})`, '',
  `Generated by \`node scripts/og/gen-social.mjs\` from \`src/data/listings.json\` (${live.length} live listings). Machine-readable twin: \`src/data/content-calendar.json\`.`, '',
  '**Rhythm**: 5 feed posts/week (Sun–Thu, publish 18:30–20:30 KSA) + 1 story every day (weekends = quiet lifestyle stories only). Launch day = 9-post grid (see `launch-posts.md`).',
  '**Pillars**: listings · Jeddah district guides · market insight (facts only — no price forecasts, no valuations: TAQEEM/REGA rule) · behind the house · buyer/seller education.',
  '**Cultural calendar**: Saudi National Day Wed 23 Sep (brand post, office closed); weekends Fri–Sat; school year already started → relocation season; no Ramadan/Eid in window. Hijri: Rabiʿ I–II 1448.',
  '**Compliance**: every *listing* post needs the REGA ad-licence number in the caption before it goes live (`adLicenceRequired: true` in JSON; placeholder line in captions). Brand/education posts do not.',
  `**3D tours & projects**: listings with a Matterport tour (${tourPool.length} now) get a "3D tour" story every ~5 days (link sticker → the tour; 'tourUrl' in JSON) and a reel on alternate Thursdays (screen-record the walkthrough, 15–30 s, 9:16). Project units (${projects.map((p) => `${p.name}: ${p.units.length}`).join(', ') || 'none yet'}) are grouped into one carousel on alternate Sundays with a unit-by-unit caption ('listingIds' in JSON). Tours hub: ${TOURS_URL}`, '',
  '| Date | Day | Format | Pillar | Topic (EN) | الموضوع | Image | Ad licence |', '|---|---|---|---|---|---|---|---|');
for (const it of items) {
  md.push(`| ${it.date} | ${weekday(it.date)} | ${it.format}${it.launch ? ` (launch #${it.launch})` : ''} | ${it.pillar} | ${it.topic.en} | ${it.topic.ar} | ${it.image ? `[img](${it.image})` : ''} | ${it.adLicenceRequired ? 'required' : '—'} |`);
}
md.push('', '## Captions', '', 'Feed-post captions (EN + AR + hashtags) are in `content-calendar.json` → `caption`. Launch captions are also in `marketing/captions/launch-0N.txt` for `scripts/instagram-post.mjs --caption-file`.', '',
  '## Weekly checklist', '- Sun: schedule the week in Meta Business Suite (Planner) or post via `scripts/instagram-post.mjs`.', '- Daily 30 min: reply to every comment/DM; comment on 5 Jeddah accounts (architects, interior studios, Jeddah Season, Saudi Sotheby\'s/Knight Frank KSA).', '- Thu: note top/bottom 3 posts of the week in the dashboard; swap next week\'s listing if one went under offer.', '- Tours & projects: when a new Matterport link or a `project` block lands in listings.json, re-run the generator — the 3D-tour stories/reels and the unit carousels pick it up automatically.', '- Re-run `node scripts/og/gen-social.mjs` after listings change; edit captions by hand in the JSON if needed (the generator overwrites — copy edits into `marketing/captions/` first).');
fs.writeFileSync(path.join(root, 'marketing/content-calendar.md'), md.join('\n') + '\n');

// launch-posts.md + caption files
const capDir = path.join(root, 'marketing/captions');
fs.mkdirSync(capDir, { recursive: true });
const lp = [];
lp.push(`# Launch-day grid — 9 posts, ${START} (Sunday)`, '',
  `Post in order #1 → #9 (about 20 minutes apart, 17:30 → 20:30 KSA) so the grid reads top-left = #9. Then pin #5 (manifesto), #9 (welcome) and #8 (sell). Generated from \`src/data/listings.json\` by \`node scripts/og/gen-social.mjs\`${placeholder ? ' — **listings.json was still a placeholder when this was generated; re-run after the data agent lands real listings.**' : ''}.`, '',
  '**Before publishing listing posts (#1, #2, #3, #6, #7):** obtain the REGA advertising licence number for each property (منصة الإعلانات العقارية / عقار) and replace the `[add number before publishing]` line. Image URLs must be JPEG for the Graph API; the site\'s hero images are JPEG unless noted.', '',
  '| # | Grid slot | Format | Type | Listing | Image |', '|---|---|---|---|---|---|');
for (const it of launchItems) lp.push(`| ${it.launch} | ${it.grid} | ${it.format} | ${it.pillar} | ${it.listingId ?? '—'} | ${it.image} |`);
lp.push('');
for (const it of launchItems) {
  const n = String(it.launch).padStart(2, '0');
  lp.push(`## Post #${it.launch} — ${it.topic.en} / ${it.topic.ar}`, '',
    `- **Grid slot**: ${it.grid} · **Format**: ${it.format} · **Pillar**: ${it.pillar}${it.listingId ? ` · **Ref**: ${it.listingId} · **Page**: ${it.url}` : ''}`,
    `- **Image${it.images.length > 1 ? 's' : ''}**: ${it.images.map((u) => `\`${u}\``).join(', ')}`,
    `- **Alt text (EN)**: ${it.alt.en}`, `- **Alt text (AR)**: ${it.alt.ar}`,
    `- **Ad licence**: ${it.adLicenceRequired ? 'REQUIRED — add number to caption' : 'not required (brand/education)'}`, '',
    '**Caption — EN**', '```', it.caption.en, '```', '**Caption — AR**', '```', it.caption.ar, '```',
    `**Hashtags (${it.hashtags.length})**`, '```', it.hashtags.join(' '), '```',
    `**Publish**: \`node scripts/instagram-post.mjs ${it.images.length > 1 ? `post-carousel --image-urls ${it.images.join(',')}` : `post-image --image-url ${it.images[0]}`} --caption-file marketing/captions/launch-${n}.txt\``, '');
  const combined = `${it.caption.ar}\n\n—\n\n${it.caption.en}\n\n${it.hashtags.join(' ')}\n`;
  fs.writeFileSync(path.join(capDir, `launch-${n}.txt`), combined);
  fs.writeFileSync(path.join(capDir, `launch-${n}.en.txt`), `${it.caption.en}\n\n${it.hashtags.join(' ')}\n`);
  fs.writeFileSync(path.join(capDir, `launch-${n}.ar.txt`), `${it.caption.ar}\n\n${it.hashtags.join(' ')}\n`);
}
lp.push('## Stories on launch day', '- 10:00 — "Today." (wordmark, countdown sticker to 17:30)', '- 17:30 — Post #1 shared to story with the WhatsApp link sticker', '- every post → story share with "Ref. BONA-0xx" text and a question sticker "Want the file?"', '- 21:00 — "9 homes. Thank you." + poll (villa/penthouse)', '',
  '## Instagram DM auto-reply for launch week', 'See `instagram-connect-checklist.md` §7.', '');
fs.writeFileSync(path.join(root, 'marketing/launch-posts.md'), lp.join('\n') + '\n');

const feed = items.filter((i) => i.format !== 'story').length;
console.log(`wrote src/data/content-calendar.json (${items.length} items: ${feed} feed posts incl. 9 launch, ${items.length - feed} stories; ${items.filter((i) => i.tourUrl).length} tour items, ${items.filter((i) => i.listingIds).length} project carousels), marketing/content-calendar.md, marketing/launch-posts.md, marketing/captions/launch-01..09.{txt,en.txt,ar.txt}`);
